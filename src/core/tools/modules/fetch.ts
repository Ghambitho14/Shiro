import { isShiroUrl } from "../../browser/pageModel.js";
import { currentAgentRun, currentResultBudget } from "../../agent/runContext.js";
import { checkUrlAllowed, classifyHost } from "../../net/addressGuard.js";
import { findInText, sliceText } from "../textSlice.js";

/**
 * fetch_url se presenta como un navegador normal: muchas webs (Cloudflare y similares) rechazan con
 * 403/429 a los agentes que no parecen un navegador. Compartido con search_web y cve_search.
 */
export const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Cabecera marca que solo pone fetch_url. El servidor de Shiro rechaza su propia API cuando la ve:
 * así una página (o alguien por WhatsApp) no puede hacer que el modelo lea tus chats o claves de
 * 127.0.0.1, aunque fetch_url ya use un User-Agent de navegador. (isShiroUrl es la primera barrera.)
 */
export const FETCH_MARK_HEADER = "x-aku-fetch";

const FETCH_HEADERS: Record<string, string> = {
	"User-Agent": BROWSER_USER_AGENT,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8",
	"Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
	[FETCH_MARK_HEADER]: "1",
};

const FETCH_TIMEOUT_MS = 15000;
/** Cuántas redirecciones se siguen (a mano, para revisar cada salto por seguridad). */
const MAX_REDIRECTS = 5;
/** Lo que se descarga como mucho; de una página más grande se usa el principio. */
export const FETCH_MAX_BYTES = 3 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/**
 * Deja solo el texto de una página HTML: sin scripts, estilos ni etiquetas, con un salto de línea
 * por bloque (párrafo, título, fila…). Las páginas de hoy son casi todo código; al modelo le sirve el texto.
 */
export function htmlToText(html: string): string {
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	const body = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|template|head|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|li|tr|table|blockquote|pre|form|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n")
		.replace(/<\/t[dh]\s*>/gi, " | ")
		.replace(/<[^>]+>/g, "");
	const lines = decodeEntities(body)
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const text = lines.join("\n");
	const cleanTitle = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
	return cleanTitle && !text.startsWith(cleanTitle) ? `# ${cleanTitle}\n\n${text}` : text;
}

/** Lee la respuesta hasta `maxBytes`; si hay más, corta la descarga y avisa con `cut`. */
async function readLimited(res: Response, maxBytes: number): Promise<{ buf: Uint8Array; cut: boolean }> {
	if (!res.body) return { buf: new Uint8Array(), cut: false };
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let cut = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > maxBytes) {
			chunks.push(value.subarray(0, maxBytes - total));
			total = maxBytes;
			cut = true;
			await reader.cancel().catch(() => {});
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const buf = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		buf.set(c, at);
		at += c.byteLength;
	}
	return { buf, cut };
}

/** Páginas ya leídas: para seguir con offset o buscar con find sin volver a bajarlas. */
const PAGE_TTL_MS = 10 * 60_000;
const PAGE_CACHE_MAX = 6;
const pages = new Map<string, { text: string; at: number }>();

function remember(url: string, text: string): void {
	pages.delete(url);
	if (pages.size >= PAGE_CACHE_MAX) pages.delete(pages.keys().next().value!);
	pages.set(url, { text, at: Date.now() });
}

/** La parte de la página que cabe en el resultado: desde `offset`, o solo los párrafos con las palabras de `find`. */
export function pagePart(text: string, args: { offset?: unknown; find?: unknown }, budget = currentResultBudget() - 300): string {
	const find = typeof args.find === "string" ? args.find.trim() : "";
	if (find) {
		const r = findInText(text, find, { context: 1, maxChars: budget });
		if (!r.hits) return `No encontré «${find}» en la página (${text.length} caracteres). Prueba con otras palabras o léela por partes con offset.`;
		return `${r.hits} ${r.hits === 1 ? "coincidencia" : "coincidencias"} de «${find}» en la página${r.shown < r.hits ? ` (van las primeras ${r.shown})` : ""}:\n\n${r.body}`;
	}
	const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
	if (!offset && text.length <= budget) return text;
	const s = sliceText(text, { offset, maxChars: budget });
	return `[Página${s.range}]\n${s.body}${s.note}`;
}

/** Un bloqueo por seguridad (SSRF) o una redirección imposible: no tiene sentido reintentarlo. */
class FetchBlocked extends Error {}

/**
 * Sigue las redirecciones a mano (máx MAX_REDIRECTS) revisando cada salto: los metadatos de nube se
 * bloquean siempre y una web pública no puede redirigir a tu red interna. En Hacking no se bloquea nada.
 */
async function fetchFollowing(startUrl: string, signal: AbortSignal, hacking: boolean): Promise<Response> {
	let url = startUrl;
	let cameFromPublic = false;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const check = await checkUrlAllowed(url, { cameFromPublic, hacking });
		if (!check.allowed) throw new FetchBlocked(check.reason);
		const res = await fetch(url, { signal, headers: FETCH_HEADERS, redirect: "manual" });
		const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (!loc) return res;
		await res.body?.cancel().catch(() => {});
		let next: URL;
		try {
			next = new URL(loc, url);
		} catch {
			throw new FetchBlocked(`La página redirige a una dirección inválida («${loc}»).`);
		}
		if (next.protocol !== "http:" && next.protocol !== "https:") throw new FetchBlocked("La página redirige a una dirección que no es web (http/https).");
		if (isShiroUrl(next.href)) throw new FetchBlocked("La página redirige a la propia web de Aku.");
		// Una vez que pasamos por un host público, cualquier salto a tu red interna es sospechoso.
		if (!cameFromPublic && !hacking && (await classifyHost(new URL(url).hostname)) === "public") cameFromPublic = true;
		url = next.href;
	}
	throw new FetchBlocked("La página redirige demasiadas veces.");
}

/** Un intento completo (con su propio tiempo máximo). Lanza en fallos de red/timeout; devuelve el resto. */
async function attempt(parsed: URL, args: Record<string, unknown>, hacking: boolean): Promise<{ ok: boolean; content: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchFollowing(parsed.href, controller.signal, hacking);
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return { ok: false, content: `HTTP ${res.status}: ${res.statusText}` };
		}
		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		if (!contentType.includes("text/") && !contentType.includes("application/json") && !contentType.includes("xml")) {
			await res.body?.cancel().catch(() => {});
			return { ok: false, content: `La URL no devuelve texto (content-type: ${contentType})` };
		}
		const { buf, cut } = await readLimited(res, FETCH_MAX_BYTES);
		const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		const isHtml = contentType.includes("html") || /^\s*(<!doctype html|<html)/i.test(raw);
		const text = (isHtml ? htmlToText(raw) : raw).trim();
		const note = cut ? `\n\n(página recortada: solo se leyeron los primeros ${FETCH_MAX_BYTES / 1024 / 1024} MB)` : "";
		const full = (text || "(Contenido vacío)") + note;
		remember(parsed.href, full);
		return { ok: true, content: pagePart(full, args) };
	} finally {
		clearTimeout(timeoutId);
	}
}

export async function executeFetchUrl(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const url = String(args.url ?? "").trim();
	if (!url) return { ok: false, content: "URL requerida" };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, content: `URL inválida: ${url}` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, content: "Solo se permiten URLs http o https" };
	}
	if (isShiroUrl(parsed.href)) return { ok: false, content: "La web de Aku no se lee con fetch_url." };

	const cached = pages.get(parsed.href);
	if (cached && Date.now() - cached.at < PAGE_TTL_MS) {
		try {
			return { ok: true, content: pagePart(cached.text, args) };
		} catch (e) {
			return { ok: false, content: e instanceof Error ? e.message : String(e) };
		}
	}

	const hacking = currentAgentRun()?.mode === "hacking";
	let lastErr = "";
	// Un reintento ante fallo de red o timeout (un bloqueo de seguridad no se reintenta).
	for (let n = 0; n < 2; n++) {
		try {
			return await attempt(parsed, args, hacking);
		} catch (e) {
			if (e instanceof FetchBlocked) return { ok: false, content: e.message };
			lastErr = e instanceof Error ? (e.name === "AbortError" ? "Timeout al conectar con la URL" : e.message) : String(e);
		}
	}
	return { ok: false, content: lastErr || "No se pudo conectar con la URL." };
}
