import type { Message, ToolCallSpec, ContentPart } from "../agent/Types.js";
import { LLMError, type ToolDef } from "./LLMClient.js";
import { PROVIDER_PRESETS, type LLMSettings } from "./providers.js";

/**
 * Una "vuelta" con el modelo: envía mensajes y devuelve texto + tool calls.
 * Hay dos dialectos: OpenAI (/chat/completions) y Ollama nativo (/api/chat).
 */
export type TurnResult = { content: string; toolCalls: ToolCallSpec[] };

export type TurnRequest = {
	messages: Message[];
	tools?: ToolDef[];
	onDelta?: (chunk: string) => void;
	signal?: AbortSignal;
};

export async function sendTurn(settings: LLMSettings, req: TurnRequest): Promise<TurnResult> {
	return settings.dialect === "ollama" ? ollamaTurn(settings, req) : openaiTurn(settings, req);
}

// ---------- utilidades ----------

let callCounter = 0;
function newCallId(): string {
	return `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;
}

/** Ollama devuelve arguments como objeto; OpenAI como string JSON. Normalizamos a string. */
function argsToString(args: unknown): string {
	if (typeof args === "string") return args || "{}";
	if (args && typeof args === "object") return JSON.stringify(args);
	return "{}";
}

function argsToObject(args: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(args || "{}");
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Imagen primero y luego texto: funciona mejor con modelos de visión. */
function orderParts(parts: ContentPart[]): ContentPart[] {
	return [...parts.filter((p) => p.type === "image_url"), ...parts.filter((p) => p.type === "text")];
}

function withTimeout(settings: LLMSettings, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(settings.timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function doFetch(settings: LLMSettings, url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: settings.headers,
			body: JSON.stringify(body),
			signal: withTimeout(settings, signal),
		});
	} catch (err) {
		throw toNetworkError(settings, err);
	}
	if (!res.ok) throw await toHttpError(settings, res);
	return res;
}

function toNetworkError(settings: LLMSettings, err: unknown): LLMError {
	const label = PROVIDER_PRESETS[settings.provider].label;
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		return new LLMError(
			`${label} tardó más de ${Math.round(settings.timeoutMs / 1000)}s en responder. Si el modelo es grande, sube "llmTimeoutMs" en la configuración.`,
			"timeout",
		);
	}
	const hint = settings.provider === "ollama" ? " ¿Está Ollama abierto? (ejecuta: ollama serve)" : settings.local ? " ¿Está el servidor encendido?" : "";
	return new LLMError(`No se pudo conectar con ${label} en ${settings.baseUrl}.${hint}`, "connection");
}

async function toHttpError(settings: LLMSettings, res: Response): Promise<LLMError> {
	const text = (await res.text().catch(() => "")).slice(0, 500);
	const label = PROVIDER_PRESETS[settings.provider].label;
	const lower = text.toLowerCase();
	if (/does not support tools|tool.*not supported|tools? (is|are) not supported|tool_choice|function calling is not/.test(lower)) {
		return new LLMError(`El modelo ${settings.model} no soporta herramientas nativas.`, "tools_unsupported", res.status);
	}
	if (res.status === 401 || res.status === 403) {
		return new LLMError(`${label} rechazó la API key (${res.status}). Revisa la clave en la configuración.`, "auth", res.status);
	}
	if (res.status === 404 && /model/.test(lower)) {
		const hint = settings.provider === "ollama" ? ` Descárgalo con: ollama pull ${settings.model}` : "";
		return new LLMError(`El modelo "${settings.model}" no existe en ${label}.${hint}`, "model_not_found", res.status);
	}
	if (res.status === 429) return new LLMError(`${label}: demasiadas peticiones (429). Espera un momento.`, "rate_limit", 429);
	if (res.status >= 500) return new LLMError(`${label} falló (${res.status}): ${text}`, "server", res.status);
	return new LLMError(`${label} rechazó la petición (${res.status}): ${text}`, "bad_request", res.status);
}

/** Lee un cuerpo en streaming línea a línea. */
async function* readLines(res: Response): AsyncGenerator<string> {
	if (!res.body) return;
	const decoder = new TextDecoder();
	let buf = "";
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		buf += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) yield line;
		}
	}
	if (buf.trim()) yield buf.trim();
}

// ---------- OpenAI compatible ----------

function toOpenAIMessage(m: Message): Record<string, unknown> {
	if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
	if (m.role === "assistant") {
		return m.tool_calls?.length ? { role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls } : { role: "assistant", content: m.content ?? "" };
	}
	if (Array.isArray(m.content)) return { role: m.role, content: orderParts(m.content) };
	return { role: m.role, content: m.content };
}

type OpenAIToolCallDelta = { index?: number; id?: string; function?: { name?: string; arguments?: unknown } };

async function openaiTurn(settings: LLMSettings, req: TurnRequest): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const body: Record<string, unknown> = {
		model: settings.model,
		messages: req.messages.map(toOpenAIMessage),
		stream,
	};
	if (settings.temperature !== undefined) body.temperature = settings.temperature;
	if (req.tools?.length) {
		body.tools = req.tools;
		body.tool_choice = "auto";
	}
	const res = await doFetch(settings, `${settings.baseUrl}/chat/completions`, body, req.signal);

	if (!stream) {
		const data = (await res.json()) as {
			choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] } }[];
		};
		const msg = data.choices?.[0]?.message;
		return {
			content: msg?.content ?? "",
			toolCalls: (msg?.tool_calls ?? [])
				.filter((tc) => tc.function?.name)
				.map((tc) => ({
					id: tc.id || newCallId(),
					type: "function" as const,
					function: { name: tc.function!.name!, arguments: argsToString(tc.function!.arguments) },
				})),
		};
	}

	let content = "";
	const calls = new Map<number, { id: string; name: string; args: string }>();
	for await (const line of readLines(res)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		let evt: { choices?: { delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] } }[]; error?: { message?: string } };
		try {
			evt = JSON.parse(payload);
		} catch {
			continue;
		}
		if (evt.error) throw new LLMError(`Error del modelo: ${evt.error.message ?? "desconocido"}`, "server");
		const delta = evt.choices?.[0]?.delta;
		if (!delta) continue;
		if (delta.content) {
			content += delta.content;
			req.onDelta?.(delta.content);
		}
		for (const tc of delta.tool_calls ?? []) {
			const idx = tc.index ?? calls.size;
			const cur = calls.get(idx) ?? { id: "", name: "", args: "" };
			if (tc.id) cur.id = tc.id;
			if (tc.function?.name) cur.name += tc.function.name;
			if (tc.function?.arguments !== undefined) {
				cur.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
			}
			calls.set(idx, cur);
		}
	}
	return {
		content,
		toolCalls: [...calls.values()]
			.filter((c) => c.name)
			.map((c) => ({ id: c.id || newCallId(), type: "function" as const, function: { name: c.name, arguments: c.args || "{}" } })),
	};
}

// ---------- Ollama nativo ----------

function toOllamaMessage(m: Message): Record<string, unknown> {
	if (m.role === "tool") return { role: "tool", content: m.content, ...(m.name ? { tool_name: m.name } : {}) };
	if (m.role === "assistant") {
		const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
		if (m.tool_calls?.length) {
			out.tool_calls = m.tool_calls.map((tc) => ({
				function: { name: tc.function.name, arguments: argsToObject(tc.function.arguments) },
			}));
		}
		return out;
	}
	if (Array.isArray(m.content)) {
		const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
		const images = m.content
			.filter((p): p is Extract<ContentPart, { type: "image_url" }> => p.type === "image_url")
			.map((p) => p.image_url.url.replace(/^data:[^,]*base64,/, ""));
		return images.length ? { role: m.role, content: text, images } : { role: m.role, content: text };
	}
	return { role: m.role, content: m.content };
}

type OllamaChunk = {
	message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
	done?: boolean;
	error?: string;
};

async function ollamaTurn(settings: LLMSettings, req: TurnRequest): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const options: Record<string, unknown> = { num_ctx: settings.contextWindow };
	if (settings.temperature !== undefined) options.temperature = settings.temperature;
	const body: Record<string, unknown> = {
		model: settings.model,
		messages: req.messages.map(toOllamaMessage),
		stream,
		options,
	};
	if (req.tools?.length) body.tools = req.tools;
	const res = await doFetch(settings, `${settings.baseUrl}/api/chat`, body, req.signal);

	let content = "";
	const toolCalls: ToolCallSpec[] = [];
	const absorb = (chunk: OllamaChunk) => {
		if (chunk.error) throw new LLMError(`Ollama: ${chunk.error}`, "server");
		const piece = chunk.message?.content ?? "";
		if (piece) {
			content += piece;
			if (stream) req.onDelta?.(piece);
		}
		for (const tc of chunk.message?.tool_calls ?? []) {
			if (!tc.function?.name) continue;
			toolCalls.push({
				id: newCallId(),
				type: "function",
				function: { name: tc.function.name, arguments: argsToString(tc.function.arguments) },
			});
		}
	};

	if (!stream) {
		absorb((await res.json()) as OllamaChunk);
	} else {
		for await (const line of readLines(res)) {
			try {
				absorb(JSON.parse(line) as OllamaChunk);
			} catch (err) {
				if (err instanceof LLMError) throw err;
			}
		}
	}
	return { content, toolCalls };
}
