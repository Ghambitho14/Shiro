/**
 * Ollama Cloud (https://ollama.com) con tu API key: el mismo formato que Ollama en el PC
 * (/api/chat), más su búsqueda web (/api/web_search y /api/web_fetch).
 */
import type { FetchFn } from "./types";

export const OLLAMA_CLOUD = "https://ollama.com";

export type ToolCall = { function: { name: string; arguments: Record<string, unknown> } };
export type OllamaMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string; images?: string[] }
	| { role: "assistant"; content: string; tool_calls?: ToolCall[] }
	| { role: "tool"; content: string; tool_name: string };

export type ToolSpec = {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type OllamaConn = { key: string; fetch?: FetchFn };

export class OllamaError extends Error {}

async function explain(res: Response, model?: string): Promise<OllamaError> {
	const text = (await res.text().catch(() => "")).slice(0, 400);
	let msg = text;
	try {
		const j = JSON.parse(text) as { error?: unknown };
		if (typeof j.error === "string") msg = j.error;
	} catch {
		// no era JSON
	}
	if (res.status === 401 || res.status === 403) return new OllamaError("Ollama Cloud rechazó la API key. Crea otra en ollama.com/settings/keys y pégala en Ajustes.");
	if (res.status === 404 && model) return new OllamaError(`El modelo "${model}" no existe en Ollama Cloud. Elige otro en Ajustes (botón «Ver modelos»).`);
	if (res.status === 429) return new OllamaError("Llegaste al límite de uso de Ollama Cloud. Espera un rato o revisa tu plan en ollama.com.");
	return new OllamaError(`Ollama Cloud respondió ${res.status}${msg ? `: ${msg}` : ""}`);
}

function headers(conn: OllamaConn): Record<string, string> {
	return { "Content-Type": "application/json", Authorization: `Bearer ${conn.key.trim()}` };
}

async function post(conn: OllamaConn, path: string, body: unknown, signal?: AbortSignal, model?: string): Promise<Response> {
	let res: Response;
	try {
		res = await (conn.fetch ?? fetch)(`${OLLAMA_CLOUD}${path}`, { method: "POST", headers: headers(conn), body: JSON.stringify(body), signal });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new OllamaError("No pude conectar con Ollama Cloud. ¿Tienes internet?");
	}
	if (!res.ok) throw await explain(res, model);
	return res;
}

/** Lee la respuesta línea a línea (Ollama manda un JSON por línea mientras escribe). */
export async function* readLines(res: Response): AsyncGenerator<string> {
	if (!res.body) {
		for (const line of (await res.text()).split("\n")) if (line.trim()) yield line;
		return;
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) yield line;
		}
	}
	buf += decoder.decode();
	if (buf.trim()) yield buf.trim();
}

type Chunk = { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }; error?: string };

function toArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object") return raw as Record<string, unknown>;
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return {};
		}
	}
	return {};
}

/** Una vuelta con el modelo: va soltando el texto por `onDelta` y devuelve lo que pidió usar. */
export async function chatTurn(
	conn: OllamaConn,
	req: { model: string; messages: OllamaMessage[]; tools?: ToolSpec[]; onDelta?: (text: string) => void; signal?: AbortSignal },
): Promise<{ content: string; toolCalls: ToolCall[] }> {
	const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
	if (req.tools?.length) body.tools = req.tools;
	const res = await post(conn, "/api/chat", body, req.signal, req.model);
	let content = "";
	const toolCalls: ToolCall[] = [];
	for await (const line of readLines(res)) {
		let chunk: Chunk;
		try {
			chunk = JSON.parse(line) as Chunk;
		} catch {
			continue;
		}
		if (chunk.error) throw new OllamaError(`Ollama Cloud: ${chunk.error}`);
		const piece = chunk.message?.content ?? "";
		if (piece) {
			content += piece;
			req.onDelta?.(piece);
		}
		for (const tc of chunk.message?.tool_calls ?? []) {
			if (tc.function?.name) toolCalls.push({ function: { name: tc.function.name, arguments: toArgs(tc.function.arguments) } });
		}
	}
	return { content, toolCalls };
}

/** Modelos de Ollama Cloud (no hace falta la clave para verlos, pero se manda por si acaso). */
export async function listModels(conn: OllamaConn): Promise<string[]> {
	let res: Response;
	try {
		res = await (conn.fetch ?? fetch)(`${OLLAMA_CLOUD}/api/tags`, { headers: conn.key.trim() ? headers(conn) : {} });
	} catch {
		throw new OllamaError("No pude conectar con Ollama Cloud. ¿Tienes internet?");
	}
	if (!res.ok) throw await explain(res);
	const j = (await res.json()) as { models?: { name?: string; model?: string }[] };
	return [...new Set((j.models ?? []).map((m) => String(m.name ?? m.model ?? "")).filter((n) => n && !/embed/i.test(n)))].sort();
}

/** Búsqueda web de Ollama (usa la misma API key). */
export async function webSearch(conn: OllamaConn, query: string, maxResults = 5, signal?: AbortSignal): Promise<{ title: string; url: string; content: string }[]> {
	const res = await post(conn, "/api/web_search", { query, max_results: Math.min(10, Math.max(1, maxResults)) }, signal);
	const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
	return (j.results ?? []).map((r) => ({ title: String(r.title ?? ""), url: String(r.url ?? ""), content: String(r.content ?? "") }));
}

/** Lee una página web con el servicio de Ollama. */
export async function webFetch(conn: OllamaConn, url: string, signal?: AbortSignal): Promise<{ title: string; content: string }> {
	const res = await post(conn, "/api/web_fetch", { url }, signal);
	const j = (await res.json()) as { title?: string; content?: string };
	return { title: String(j.title ?? ""), content: String(j.content ?? "") };
}
