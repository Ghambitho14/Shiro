import { isShiroUrl } from "../../browser/pageModel.js";

/**
 * Así se presenta fetch_url. El servidor de Shiro rechaza su API con este agente: una página
 * (o alguien por WhatsApp) no puede hacer que el modelo lea tus chats o claves de 127.0.0.1,
 * ni siquiera con una redirección.
 */
export const FETCH_USER_AGENT = "Shiro/1.0 (AI agent)";

const FETCH_TIMEOUT_MS = 15000;
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
	if (isShiroUrl(parsed.href)) return { ok: false, content: "La web de Shiro no se lee con fetch_url." };

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": FETCH_USER_AGENT },
			redirect: "follow",
		});

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
		clearTimeout(timeoutId);

		const raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		const isHtml = contentType.includes("html") || /^\s*(<!doctype html|<html)/i.test(raw);
		const text = (isHtml ? htmlToText(raw) : raw).trim();
		const note = cut ? `\n\n(página recortada: solo se leyeron los primeros ${FETCH_MAX_BYTES / 1024 / 1024} MB)` : "";
		return { ok: true, content: (text || "(Contenido vacío)") + note };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error) {
			if (e.name === "AbortError") return { ok: false, content: "Timeout al conectar con la URL" };
			return { ok: false, content: e.message };
		}
		return { ok: false, content: String(e) };
	}
}
