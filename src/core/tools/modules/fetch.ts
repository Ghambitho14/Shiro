import type { ToolDefinition } from "../ToolRegistry.js";

export const fetchUrlTool: ToolDefinition = {
	label: "Obtener URL",
	name: "fetch_url",
	description: "Obtiene el contenido de una URL (página web, API).",
	category: "web",
	parameters: {
		type: "object",
		properties: { url: { type: "string", description: "URL completa (http:// o https://)" } },
		required: ["url"],
	},
};

export async function executeFetchUrl(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const url = String(args.url ?? "").trim();
	if (!url) return { ok: false, content: "URL requerida" };

	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, content: "Solo se permiten URLs http o https" };
	}

	const FETCH_TIMEOUT_MS = 15000;
	const FETCH_MAX_BYTES = 150 * 1024;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": "Shiro/1.0 (AI agent)" },
			redirect: "follow",
		});
		clearTimeout(timeoutId);

		if (!res.ok) return { ok: false, content: `HTTP ${res.status}: ${res.statusText}` };

		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		if (!contentType.includes("text/") && !contentType.includes("application/json") && !contentType.includes("application/xml")) {
			return { ok: false, content: `La URL no devuelve texto (content-type: ${contentType})` };
		}

		const buf = await res.arrayBuffer();
		if (buf.byteLength > FETCH_MAX_BYTES) {
			return { ok: false, content: `Respuesta demasiado grande (máx ${FETCH_MAX_BYTES / 1024} KB)` };
		}

		const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		return { ok: true, content: text.trim() || "(Contenido vacío)" };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error) {
			if (e.name === "AbortError") return { ok: false, content: "Timeout al conectar con la URL" };
			return { ok: false, content: e.message };
		}
		return { ok: false, content: String(e) };
	}
}
