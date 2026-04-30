import type { ToolDefinition } from "../ToolRegistry.js";

export const httpRequestTool: ToolDefinition = {
	label: "HTTP Request",
	name: "http_request",
	description: "Hace requests HTTP (GET, POST) con headers y body personalizado.",
	category: "web",
	parameters: {
		type: "object",
		properties: {
			url: { type: "string", description: "URL completa" },
			method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "Método HTTP" },
			headers: { type: "object", description: "Headers como objeto JSON" },
			body: { type: "string", description: "Body para POST/PUT/PATCH (JSON string)" },
		},
		required: ["url", "method"],
	},
};

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

export async function executeHttpRequest(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const url = String(args.url ?? "").trim();
	const method = String(args.method ?? "GET").toUpperCase();
	
	if (!url) return { ok: false, content: "URL requerida" };
	
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, content: "Solo se permiten URLs http o https" };
	}
	
	const headersObj = args.headers as Record<string, string> | undefined;
	const body = args.body as string | undefined;
	
	const REQUEST_TIMEOUT_MS = 20000;
	const REQUEST_MAX_BYTES = 200 * 1024;
	
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	
	try {
		const headers: Record<string, string> = {
			"User-Agent": "Shiro/1.0 (AI agent)",
			...headersObj,
		};
		
		if (body && !headers["Content-Type"]) {
			headers["Content-Type"] = "application/json";
		}
		
		const fetchOptions: RequestInit = {
			method,
			headers,
			signal: controller.signal,
			redirect: "follow",
		};
		
		if (body && ["POST", "PUT", "PATCH"].includes(method)) {
			fetchOptions.body = body;
		}
		
		const res = await fetch(url, fetchOptions);
		clearTimeout(timeoutId);
		
		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		const isJson = contentType.includes("application/json");
		
		const buf = await res.arrayBuffer();
		if (buf.byteLength > REQUEST_MAX_BYTES) {
			return { ok: false, content: `Respuesta demasiado grande (máx ${REQUEST_MAX_BYTES / 1024} KB)` };
		}
		
		let responseBody: string;
		if (isJson) {
			const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
			try {
				const json = JSON.parse(text);
				responseBody = JSON.stringify(json, null, 2);
			} catch {
				responseBody = text;
			}
		} else {
			responseBody = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		}
		
		const responseText = `Status: ${res.status} ${res.statusText}\n\n${responseBody}`;
		return { ok: true, content: responseText };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error) {
			if (e.name === "AbortError") return { ok: false, content: "Timeout al conectar con la URL" };
			return { ok: false, content: e.message };
		}
		return { ok: false, content: String(e) };
	}
}
