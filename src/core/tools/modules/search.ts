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
		const titleRegex = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
		const snippetRegex = /<a class="result__snippet"[^>]*>([^<]+)<\/a>/g;
		let match;
		let count = 0;

		while ((match = titleRegex.exec(text)) !== null && count < 5) {
			const url = normalizeDuckDuckGoUrl(match[1]);
			const title = match[2].replace(/<[^>]+>/g, "").trim();
			const snippetMatch = snippetRegex.exec(text);
			const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, "").trim() : "";

			const urlLine = url ? `\n   URL: ${url}` : "";
			const snippetLine = snippet ? `\n   Snippet: ${snippet}` : "";
			results.push(`${count + 1}. ${title}${urlLine}${snippetLine}`);
			count++;
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
