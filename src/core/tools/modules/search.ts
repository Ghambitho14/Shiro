import { BROWSER_USER_AGENT } from "./fetch.js";

const SEARCH_TIMEOUT_MS = 15000;

function normalizeDuckDuckGoUrl(href: string): string {
	// DuckDuckGo suele devolver links tipo "/l/?uddg=<encoded>&..." en vez de la URL final.
	try {
		const candidate = href.startsWith("http") ? href : `https://duckduckgo.com${href}`;
		const url = new URL(candidate);
		const uddg = url.searchParams.get("uddg");
		if (uddg) return uddg;
		return url.toString();
	} catch {
		return href;
	}
}

/** Quitar marcas HTML y compactar espacios (los snippets llevan <b>, entidades, etc.). */
function stripHtml(raw: string): string {
	return raw
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#x27;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)))
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, " ")
		.trim();
}

/** Da formato a un resultado (numerado, con URL y snippet si los hay). */
function formatResult(n: number, title: string, url: string, snippet: string): string {
	return `${n}. ${title}${url ? `\n   URL: ${url}` : ""}${snippet ? `\n   Snippet: ${snippet}` : ""}`;
}

/** Parser de html.duckduckgo.com/html (resultados en bloques result results_links). */
function parseHtmlResults(text: string): string[] {
	const results: string[] = [];
	// DDG HTML usa <a rel="nofollow" class="result__a" href="..."> (class no va siempre primero).
	const blockRe = /<div class="(result results_links results_links_deep[^"]*)">([\s\S]*?)<div class="clear"><\/div>/g;
	let blockMatch: RegExpExecArray | null;
	while ((blockMatch = blockRe.exec(text)) !== null && results.length < 8) {
		if (blockMatch[1].includes("result--ad")) continue;
		const body = blockMatch[2];
		const titleTag = /<a([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>/i.exec(body);
		if (!titleTag) continue;
		const hrefSub = /href="([^"]*)"/i.exec(titleTag[1]);
		const url = hrefSub ? normalizeDuckDuckGoUrl(hrefSub[1]) : "";
		const title = stripHtml(titleTag[2]);
		if (!title) continue;
		const snippetM = /<a[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
		const snippet = snippetM ? stripHtml(snippetM[1]) : "";
		results.push(formatResult(results.length + 1, title, url, snippet));
	}
	return results;
}

/** Parser del endpoint lite.duckduckgo.com/lite (markup más simple: enlaces result-link + snippets en celdas). */
function parseLiteResults(html: string): string[] {
	const snippets: string[] = [];
	const snipRe = /<td[^>]*\bclass=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
	let sm: RegExpExecArray | null;
	while ((sm = snipRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));

	const results: string[] = [];
	const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	let i = 0;
	while ((m = aRe.exec(html)) !== null && results.length < 8) {
		const attrs = m[1];
		if (!/\bresult-link\b/.test(attrs)) continue;
		const title = stripHtml(m[2]);
		if (!title) continue;
		const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
		const url = href ? normalizeDuckDuckGoUrl(href) : "";
		results.push(formatResult(results.length + 1, title, url, snippets[i++] ?? ""));
	}
	return results;
}

async function fetchText(url: string): Promise<string> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
			},
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.text();
	} finally {
		clearTimeout(timeoutId);
	}
}

function explainError(e: unknown): string {
	if (e instanceof Error) return e.name === "AbortError" ? "Timeout en búsqueda" : e.message;
	return String(e);
}

export async function executeSearchWeb(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const query = String(args.query ?? "").trim();
	if (!query) return { ok: false, content: "Query de búsqueda requerida" };
	if (query.length > 200) return { ok: false, content: "Query demasiado larga (máx 200 caracteres)" };

	const primary = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const lite = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;

	let results: string[] = [];
	let lastErr = "";

	// 1) DuckDuckGo HTML, con un reintento solo ante fallo de red (no si responde con 0 resultados).
	for (let n = 0; n < 2; n++) {
		try {
			results = parseHtmlResults(await fetchText(primary));
			break;
		} catch (e) {
			lastErr = explainError(e);
		}
	}

	// 2) Respaldo: endpoint lite (formato más estable), si el primero falló o no devolvió nada.
	if (results.length === 0) {
		try {
			results = parseLiteResults(await fetchText(lite));
		} catch (e) {
			if (!lastErr) lastErr = explainError(e);
		}
	}

	if (results.length === 0) {
		return lastErr ? { ok: false, content: `No pude buscar ahora (${lastErr}).` } : { ok: true, content: "No se encontraron resultados para: " + query };
	}
	return { ok: true, content: "Resultados de búsqueda:\n" + results.join("\n") };
}
