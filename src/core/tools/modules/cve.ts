/**
 * Consulta de CVE (vulnerabilidades) por API, para el modo CodeHacking.
 *
 * Fuente: CIRCL (https://cve.circl.lu), gratis y sin llave. Se puede cambiar con la variable
 * de entorno SHIRO_CVE_API (por si la API de CIRCL cambia de dirección).
 *
 * Es de SOLO LECTURA (no tiene efectos), así que no pide permiso; pero trae texto de afuera,
 * así que está en WEB_TOOLS (untrusted.ts) y su salida llega al modelo como CONTENIDO EXTERNO.
 */
import { FETCH_USER_AGENT } from "./fetch.js";

const CVE_API = (process.env.SHIRO_CVE_API || "https://cve.circl.lu/api").replace(/\/+$/, "");
const CVE_TIMEOUT_MS = 15000;
/** Como mucho se leen 3 MB de la respuesta (una lista grande de CVE puede pesar). */
const CVE_MAX_BYTES = 3 * 1024 * 1024;
/** Cuántos resultados y referencias se muestran como mucho (no saturar el contexto del modelo). */
const MAX_RESULTS = 15;
const MAX_REFERENCES = 12;

const CVE_ID_RE = /^CVE-\d{4}-\d{3,}$/i;

/** Primer valor no vacío entre varias claves posibles (la API ha cambiado de forma con el tiempo). */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
	for (const k of keys) {
		const v = obj[k];
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

function asString(v: unknown): string {
	return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
}

/** Saca una lista de URLs de referencias en los distintos formatos que devuelve la API. */
function referencesOf(obj: Record<string, unknown>): string[] {
	// Clásico: references en el nivel superior. CVE 5.x: containers.cna.references.
	const containers = obj.containers as Record<string, unknown> | undefined;
	const cna = containers?.cna as Record<string, unknown> | undefined;
	const raw = pick(obj, "references") ?? cna?.references;
	const out: string[] = [];
	if (Array.isArray(raw)) {
		for (const r of raw) {
			if (typeof r === "string") out.push(r);
			else if (r && typeof r === "object") {
				const url = asString((r as Record<string, unknown>).url);
				if (url) out.push(url);
			}
		}
	}
	return [...new Set(out)].slice(0, MAX_REFERENCES);
}

/** Puntuación CVSS en cualquiera de las claves conocidas. */
function cvssOf(obj: Record<string, unknown>): string {
	const direct = pick(obj, "cvss", "cvss3", "cvssV3", "cvss_score", "baseScore");
	if (direct !== undefined) return asString(direct);
	// Formato CVE 5.x: containers.cna.metrics[].cvssV3_1.baseScore
	const containers = obj.containers as Record<string, unknown> | undefined;
	const cna = containers?.cna as Record<string, unknown> | undefined;
	const metrics = cna?.metrics;
	if (Array.isArray(metrics)) {
		for (const m of metrics) {
			if (!m || typeof m !== "object") continue;
			for (const val of Object.values(m as Record<string, unknown>)) {
				if (val && typeof val === "object") {
					const score = (val as Record<string, unknown>).baseScore;
					if (score !== undefined) return asString(score);
				}
			}
		}
	}
	return "";
}

/** Resumen/descripción en cualquiera de las claves conocidas. */
function summaryOf(obj: Record<string, unknown>): string {
	const direct = pick(obj, "summary", "description");
	if (typeof direct === "string") return direct.trim();
	// Formato CVE 5.x: containers.cna.descriptions[].value
	const containers = obj.containers as Record<string, unknown> | undefined;
	const cna = containers?.cna as Record<string, unknown> | undefined;
	const descriptions = cna?.descriptions;
	if (Array.isArray(descriptions)) {
		const en = descriptions.find((d) => d && typeof d === "object" && /en/i.test(asString((d as Record<string, unknown>).lang)));
		const d = (en ?? descriptions[0]) as Record<string, unknown> | undefined;
		if (d) return asString(d.value);
	}
	return "";
}

function idOf(obj: Record<string, unknown>): string {
	const direct = pick(obj, "id", "cveId", "CVE_ID");
	if (direct !== undefined) return asString(direct);
	const meta = obj.cveMetadata as Record<string, unknown> | undefined;
	if (meta) return asString(meta.cveId);
	return "";
}

/** Texto legible de un solo CVE. */
export function formatCve(obj: Record<string, unknown>): string {
	const id = idOf(obj) || "(sin id)";
	const cvss = cvssOf(obj);
	const summary = summaryOf(obj);
	const published = asString(pick(obj, "Published", "published", "datePublished"));
	const modified = asString(pick(obj, "Modified", "modified", "dateUpdated"));
	const products = pick(obj, "vulnerable_product", "vulnerable_configuration");
	const refs = referencesOf(obj);

	const lines = [`${id}${cvss ? ` — CVSS ${cvss}` : ""}`];
	if (published) lines.push(`Publicado: ${published}${modified ? ` · Modificado: ${modified}` : ""}`);
	if (summary) lines.push(`\n${summary}`);
	if (Array.isArray(products) && products.length) {
		lines.push(`\nProductos afectados (${products.length}): ${products.slice(0, 10).map(asString).join(", ")}${products.length > 10 ? ", …" : ""}`);
	}
	if (refs.length) lines.push(`\nReferencias:\n${refs.map((r) => `- ${r}`).join("\n")}`);
	return lines.join("\n");
}

/** Texto legible de una lista de resultados de búsqueda. */
function formatList(items: unknown[], query: string): string {
	if (!items.length) return `No encontré CVE para «${query}».`;
	const shown = items.slice(0, MAX_RESULTS);
	const rows = shown.map((it) => {
		const obj = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
		const id = idOf(obj) || "(sin id)";
		const cvss = cvssOf(obj);
		const summary = summaryOf(obj).replace(/\s+/g, " ").slice(0, 160);
		return `- ${id}${cvss ? ` (CVSS ${cvss})` : ""}: ${summary}`;
	});
	const more = items.length > shown.length ? `\n…y ${items.length - shown.length} más.` : "";
	return `${items.length} CVE para «${query}» (los ${shown.length} primeros):\n${rows.join("\n")}${more}`;
}

/** Saca la lista de resultados sea cual sea la envoltura que use la API. */
function resultsFrom(data: unknown): unknown[] | null {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		for (const key of ["results", "data", "cves", "vulnerabilities"]) {
			if (Array.isArray(obj[key])) return obj[key] as unknown[];
		}
	}
	return null;
}

async function fetchJson(url: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), CVE_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": FETCH_USER_AGENT, Accept: "application/json" },
			redirect: "follow",
		});
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
		}
		const reader = res.body?.getReader();
		if (!reader) return { ok: false, error: "Respuesta vacía de la API de CVE." };
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > CVE_MAX_BYTES) {
				await reader.cancel().catch(() => {});
				return { ok: false, error: "La respuesta de CVE es demasiado grande; acota la búsqueda (indica vendor y product, o un CVE-ID)." };
			}
			chunks.push(value);
		}
		const buf = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			buf.set(c, at);
			at += c.byteLength;
		}
		const text = new TextDecoder("utf-8", { fatal: false }).decode(buf).trim();
		if (!text) return { ok: false, error: "La API de CVE no devolvió datos." };
		try {
			return { ok: true, data: JSON.parse(text) };
		} catch {
			return { ok: false, error: "La API de CVE no devolvió JSON válido." };
		}
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") return { ok: false, error: "Timeout al consultar la API de CVE." };
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Busca CVE en CIRCL. Modos:
 * - id: un CVE concreto (p. ej. CVE-2024-3094).
 * - vendor + product: CVE de un producto (p. ej. openbsd / openssh).
 * - product (solo): búsqueda libre por producto.
 * Nunca lanza; devuelve { ok, content } con el error en español si algo falla.
 */
export async function executeCveSearch(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const id = asString(args.id);
	const vendor = asString(args.vendor);
	const product = asString(args.product);

	// Si viene un CVE-ID (en id o colado en product), se busca ese CVE concreto.
	const directId = CVE_ID_RE.test(id) ? id : CVE_ID_RE.test(product) ? product : "";
	if (directId) {
		const r = await fetchJson(`${CVE_API}/cve/${encodeURIComponent(directId.toUpperCase())}`);
		if (!r.ok) return { ok: false, content: r.error };
		if (!r.data || (typeof r.data === "object" && Object.keys(r.data as object).length === 0)) {
			return { ok: true, content: `No encontré datos para ${directId.toUpperCase()}.` };
		}
		return { ok: true, content: formatCve(r.data as Record<string, unknown>) };
	}

	if (id) return { ok: false, content: `«${id}» no parece un CVE-ID (formato: CVE-AAAA-NNNN). Para buscar por producto usa vendor y/o product.` };

	if (!vendor && !product) {
		return { ok: false, content: "Indica un id (CVE-AAAA-NNNN) o un product (y opcionalmente vendor) para buscar." };
	}

	const query = [vendor, product].filter(Boolean).join("/");
	const path =
		vendor && product
			? `search/${encodeURIComponent(vendor)}/${encodeURIComponent(product)}`
			: `search/${encodeURIComponent(product || vendor)}`;
	const r = await fetchJson(`${CVE_API}/${path}`);
	if (!r.ok) return { ok: false, content: r.error };
	const list = resultsFrom(r.data);
	if (!list) {
		// Formato inesperado: al menos devolver algo útil al modelo.
		const raw = JSON.stringify(r.data).slice(0, 2000);
		return { ok: true, content: `Respuesta de la API (formato no reconocido):\n${raw}` };
	}
	return { ok: true, content: formatList(list, query) };
}
