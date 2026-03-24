import type { ToolDefinition } from "../ToolRegistry.js";

export const searchWebTool: ToolDefinition = {
	label: "Buscar en Internet",
	name: "search_web",
	description: "Busca información en internet.",
	category: "web",
	parameters: {
		type: "object",
		properties: { query: { type: "string", description: "Consulta de búsqueda" } },
		required: ["query"],
	},
};

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

export async function executeSearchWeb(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const query = String(args.query ?? "").trim();
	if (!query) return { ok: false, content: "Query de búsqueda requerida" };
	if (query.length > 200) return { ok: false, content: "Query demasiado larga (máx 200 caracteres)" };

	const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 15000);

	try {
		const res = await fetch(searchUrl, {
			signal: controller.signal,
			headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
		});
		clearTimeout(timeoutId);

		if (!res.ok) return { ok: false, content: `HTTP ${res.status}` };

		const text = await res.text();
		const results: string[] = [];

		/** Quitar marcas HTML y compactar espacios (los snippets llevan &lt;b&gt;, etc.). */
		const stripHtml = (raw: string) =>
			raw
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

		// DDG HTML usa <a rel="nofollow" class="result__a" href="..."> (class no va siempre primero).
		const blockRe =
			/<div class="(result results_links results_links_deep[^"]*)">([\s\S]*?)<div class="clear"><\/div>/g;
		let blockMatch: RegExpExecArray | null;
		while ((blockMatch = blockRe.exec(text)) !== null && results.length < 8) {
			const blockClasses = blockMatch[1];
			if (blockClasses.includes("result--ad")) continue;

			const body = blockMatch[2];
			const titleTag = /<a([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>/i.exec(body);
			if (!titleTag) continue;

			const hrefSub = /href="([^"]*)"/i.exec(titleTag[1]);
			const resolvedUrl = hrefSub ? normalizeDuckDuckGoUrl(hrefSub[1]) : "";
			const title = stripHtml(titleTag[2]);
			if (!title) continue;

			const snippetM = /<a[^>]*\bclass="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
			const snippet = snippetM ? stripHtml(snippetM[1]) : "";

			const n = results.length + 1;
			const urlLine = resolvedUrl ? `\n   URL: ${resolvedUrl}` : "";
			const snippetLine = snippet ? `\n   Snippet: ${snippet}` : "";
			results.push(`${n}. ${title}${urlLine}${snippetLine}`);
		}

		if (results.length === 0) {
			return { ok: true, content: "No se encontraron resultados para: " + query };
		}

		return { ok: true, content: "Resultados de búsqueda:\n" + results.join("\n") };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error && e.name === "AbortError") {
			return { ok: false, content: "Timeout en búsqueda" };
		}
		return { ok: false, content: e instanceof Error ? e.message : String(e) };
	}
}
