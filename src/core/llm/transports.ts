import { createHash, randomUUID } from "node:crypto";
import type { AssistantCarry, Message, ToolCallSpec, ContentPart } from "../agent/Types.js";
import { LLMError, type TokenUsage, type ToolDef } from "./LLMClient.js";
import { PROVIDER_PRESETS, type LLMSettings } from "./providers.js";

/**
 * Una "vuelta" con el modelo: envía mensajes y devuelve texto + tool calls.
 * Dialectos: OpenAI (/chat/completions), Ollama nativo (/api/chat),
 * Anthropic (/messages) y OpenAI Responses (/responses).
 */
export type TurnResult = {
	content: string;
	toolCalls: ToolCallSpec[];
	/** Razonamiento que hay que devolver al modelo junto a sus tool calls en la siguiente vuelta. */
	carry?: AssistantCarry;
	/** Tokens que gastó esta vuelta, si el servidor lo dice. */
	usage?: TokenUsage;
};

/** Tokens aproximados de un texto (para el razonamiento cuando el servidor no lo cuenta aparte). */
const approxTokens = (text: string) => Math.ceil(text.length / 3.5);

type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };

/** Uso del formato OpenAI. Si no separa el razonamiento, se estima por el texto que devolvió. */
function openaiUsage(u: OpenAIUsage | null | undefined, reasoningText: string): TokenUsage | undefined {
	if (!u || (u.prompt_tokens === undefined && u.completion_tokens === undefined)) return undefined;
	const reasoning = u.completion_tokens_details?.reasoning_tokens || (reasoningText ? approxTokens(reasoningText) : 0);
	return { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, ...(reasoning ? { reasoning } : {}) };
}

export type TurnRequest = {
	messages: Message[];
	tools?: ToolDef[];
	onDelta?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Id de la conversación; ver opencodeSessionHeader(). */
	sessionId?: string;
};

/** Para lo que no tiene conversación propia (terminal, doctor): una sesión por ejecución. */
const processSession = randomUUID();

/**
 * OpenCode Go rechaza las peticiones sin "x-opencode-session": un id estable por conversación.
 * Se envía un hash del id del chat: nunca sale el id real, y siempre es un valor de cabecera válido.
 */
export function opencodeSessionHeader(sessionId?: string): string {
	return `shiro-${createHash("sha256").update(sessionId || processSession).digest("hex").slice(0, 32)}`;
}

export async function sendTurn(settings: LLMSettings, req: TurnRequest): Promise<TurnResult> {
	if (settings.unsupported) throw new LLMError(settings.unsupported, "bad_request");
	const preset = PROVIDER_PRESETS[settings.provider];
	if (preset.needsApiKey && !settings.apiKey) {
		const where = preset.keyUrl ? ` Cópiala de ${preset.keyUrl} y` : "";
		throw new LLMError(`Falta la API key de ${preset.label}.${where} ponla en Ajustes → Modelo.`, "auth");
	}
	if (preset.catalog) {
		settings = { ...settings, headers: { ...settings.headers, "x-opencode-session": opencodeSessionHeader(req.sessionId) } };
	}
	const turn = (extra: Record<string, unknown>) => {
		switch (settings.dialect) {
			case "ollama":
				return ollamaTurn(settings, req, extra);
			case "anthropic":
				return anthropicTurn(settings, req);
			case "responses":
				return responsesTurn(settings, req, extra);
			default:
				return openaiTurn(settings, req, extra);
		}
	};
	// Cuánto piensa: cada servidor lo pide a su manera y no todos lo aceptan. Se prueba la primera
	// opción; si el servidor la rechaza, la siguiente (la última es no pedir nada). La que funciona
	// se recuerda para no repetir el intento fallido en cada mensaje.
	const options = reasoningOptions(settings);
	const memo = `${settings.provider}|${settings.model}|${settings.thinking}`;
	for (let i = reasoningMemo.get(memo) ?? 0; ; i++) {
		try {
			const result = await turn(options[i]);
			if (i > 0) reasoningMemo.set(memo, i);
			return result;
		} catch (err) {
			const last = i >= options.length - 1;
			if (last || !(err instanceof LLMError) || !isReasoningRejection(err)) throw err;
		}
	}
}

/** Qué opción de razonamiento funcionó con cada modelo (índice en reasoningOptions). */
const reasoningMemo = new Map<string, number>();

/**
 * Lo que se añade a la petición para elegir cuánto piensa el modelo, de la opción preferida a la
 * de reserva. La última siempre es {} (no pedir nada: lo que diga el modelo).
 * - Ollama: `think` (true/false; gpt-oss y otros aceptan "low" | "medium" | "high").
 * - llama.cpp, vLLM, LM Studio: la plantilla del modelo (`enable_thinking`, Qwen3…) y `reasoning_effort`.
 * - OpenRouter: su objeto `reasoning`.
 * - OpenCode y otros de la nube: `reasoning_effort` (estándar de OpenAI) y `thinking` (GLM, Kimi, DeepSeek).
 * - /responses (GPT): `reasoning.effort`.
 * - Formato Anthropic: no se toca (Claude solo piensa si se le pide, y Shiro no se lo pide).
 */
export function reasoningOptions(settings: Pick<LLMSettings, "dialect" | "local" | "provider" | "thinking" | "model">): Record<string, unknown>[] {
	const level = settings.thinking ?? "auto";
	if (level === "auto" || settings.dialect === "anthropic") return [{}];
	const effort = level === "on" ? "medium" : level;
	const wantsThinking = level !== "off";

	if (settings.dialect === "ollama") {
		// gpt-oss no deja de pensar con think:false (lo ignora): lo mínimo que acepta es "low".
		if (level === "off" && /gpt-oss/i.test(settings.model)) return [{ think: "low" }, {}];
		if (level === "off") return [{ think: false }, {}];
		if (level === "on") return [{ think: true }, {}];
		return [{ think: effort }, { think: true }, {}];
	}
	if (settings.dialect === "responses") {
		if (level === "off") return [{ reasoning: { effort: "none" } }, { reasoning: { effort: "minimal" } }, { reasoning: { effort: "low" } }, {}];
		if (level === "on") return [{}];
		return [{ reasoning: { effort } }, {}];
	}
	if (settings.local) {
		const template = { chat_template_kwargs: { enable_thinking: wantsThinking } };
		if (level === "off" || level === "on") return [template, {}];
		return [{ ...template, reasoning_effort: effort }, template, {}];
	}
	if (settings.provider === "openrouter") {
		if (level === "off") return [{ reasoning: { effort: "none" } }, { reasoning: { enabled: false } }, {}];
		if (level === "on") return [{ reasoning: { enabled: true } }, {}];
		return [{ reasoning: { effort } }, {}];
	}
	if (level === "off") {
		return [
			{ reasoning_effort: "none", thinking: { type: "disabled" } },
			{ thinking: { type: "disabled" } },
			{ reasoning_effort: "minimal" },
			{ reasoning_effort: "low" },
			{},
		];
	}
	if (level === "on") return [{}];
	return [{ reasoning_effort: effort }, {}];
}

/** ¿El servidor rechazó la forma de pedir el razonamiento (y no otra cosa)? */
function isReasoningRejection(err: LLMError): boolean {
	if (err.kind === "reasoning_unsupported") return true;
	if (err.kind !== "bad_request" || (err.status !== undefined && err.status !== 400 && err.status !== 422)) return false;
	return /reason|think|effort|enable_thinking|chat_template|unrecognized|unknown (parameter|field|argument|variant)|extra (fields|inputs)|not permitted|unsupported (parameter|value)/i.test(err.message);
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
		// El usuario pulsó "Detener": no es un fallo del modelo.
		if (signal?.aborted) throw new LLMError("Respuesta detenida por el usuario.", "cancelled");
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
	if (PROVIDER_PRESETS[settings.provider].managed) {
		return new LLMError(`Se perdió la conexión con llama.cpp (${settings.model}). Vuelve a enviar el mensaje: Aku lo abrirá de nuevo.`, "connection");
	}
	const hint = settings.provider === "ollama" ? " ¿Está Ollama abierto? (ejecuta: ollama serve)" : settings.local ? " ¿Está el servidor encendido?" : "";
	return new LLMError(`No se pudo conectar con ${label} en ${settings.baseUrl}.${hint}`, "connection");
}

/** Saca el mensaje del servidor de un error en JSON: {"error": "..."} o {"error": {"type", "message"}}. */
function parseErrorBody(text: string): { message: string; type: string } {
	try {
		const data = JSON.parse(text) as { error?: unknown; message?: unknown };
		if (typeof data.error === "string") return { message: data.error, type: "" };
		if (data.error && typeof data.error === "object") {
			const e = data.error as { message?: unknown; type?: unknown; code?: unknown };
			return { message: typeof e.message === "string" ? e.message : "", type: String(e.type ?? e.code ?? "") };
		}
		if (typeof data.message === "string") return { message: data.message, type: "" };
	} catch {
		// No era JSON: se usa el texto tal cual.
	}
	return { message: "", type: "" };
}

/**
 * ¿La petición no cabe en el contexto del modelo? llama.cpp: "request (9907 tokens) exceeds the
 * available context size (8192 tokens)"; OpenAI y otros: "maximum context length".
 */
export function contextOverflow(type: string, message: string): { used?: number; max?: number } | null {
	const m = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(message);
	if (m) return { used: Number(m[1]), max: Number(m[2]) };
	if (/exceed_context_size|context_length_exceeded/i.test(type)) return {};
	if (/exceeds? (the )?(available |maximum )?context (size|length|window)|maximum context length|context length exceeded|prompt is too long/i.test(message)) return {};
	return null;
}

async function toHttpError(settings: LLMSettings, res: Response): Promise<LLMError> {
	const text = (await res.text().catch(() => "")).slice(0, 500);
	const label = PROVIDER_PRESETS[settings.provider].label;
	const lower = text.toLowerCase();
	const server = parseErrorBody(text);
	const detail = server.message || text;
	const tooLong = contextOverflow(server.type, detail);
	if (tooLong) {
		const sizes = tooLong.used && tooLong.max ? ` (ocupa ${tooLong.used} tokens y el modelo admite ${tooLong.max} a la vez)` : "";
		const fix = PROVIDER_PRESETS[settings.provider].managed
			? "Pon el «Tamaño de contexto» en Automático o súbelo en Ajustes → Modelo, o empieza un chat nuevo."
			: settings.local
				? `Aumenta el contexto en ${label} o empieza un chat nuevo.`
				: "Empieza un chat nuevo o elige un modelo con más contexto.";
		return new LLMError(`La conversación no cabe en la memoria del modelo${sizes}. ${fix}`, "bad_request", res.status);
	}
	if (/does not support thinking|thinking is not supported/.test(lower)) {
		return new LLMError(`El modelo ${settings.model} no sabe «pensar antes de responder». Ponlo en «Lo que diga el modelo» en Ajustes → Modelo.`, "reasoning_unsupported", res.status);
	}
	if (/does not support tools|tool.*not supported|tools? (is|are) not supported|tool_choice|function calling is not/.test(lower)) {
		return new LLMError(`El modelo ${settings.model} no soporta herramientas nativas.`, "tools_unsupported", res.status);
	}
	// OpenCode responde 401 con "ModelError" cuando el modelo no existe o no entra en tu plan.
	if (server.type === "ModelError" || (res.status === 404 && /model/.test(lower))) {
		const hint =
			settings.provider === "ollama"
				? ` Descárgalo con: ollama pull ${settings.model}`
				: settings.local && !PROVIDER_PRESETS[settings.provider].managed
					? ""
					: " Elige otro en el selector de modelos.";
		return new LLMError(`El modelo "${settings.model}" no está disponible en ${label}.${hint}`, "model_not_found", res.status);
	}
	if (res.status === 401 || res.status === 403) {
		if (!server.message || /key|auth|token|credential/i.test(`${server.type} ${server.message}`)) {
			return new LLMError(`${label} rechazó la API key (${res.status}). Revisa la clave en la configuración.`, "auth", res.status);
		}
		return new LLMError(`${label} no permitió la petición (${res.status}): ${server.message}`, "auth", res.status);
	}
	if (res.status === 429) {
		// En una suscripción el servidor explica qué límite se alcanzó: se muestra tal cual.
		return new LLMError(`${label}: ${server.message || "demasiadas peticiones. Espera un momento."} (429)`, "rate_limit", 429);
	}
	if (res.status >= 500) return new LLMError(`${label} falló (${res.status}): ${detail}`, "server", res.status);
	return new LLMError(`${label} rechazó la petición (${res.status}): ${detail}`, "bad_request", res.status);
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
		if (!m.tool_calls?.length) return { role: "assistant", content: m.content ?? "" };
		// Los modelos que razonan (DeepSeek, Kimi…) rechazan la petición si no se les devuelve su razonamiento.
		return {
			role: "assistant",
			content: m.content ?? "",
			tool_calls: m.tool_calls,
			...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
		};
	}
	if (Array.isArray(m.content)) return { role: m.role, content: orderParts(m.content) };
	return { role: m.role, content: m.content };
}

type OpenAIToolCallDelta = { index?: number; id?: string; function?: { name?: string; arguments?: unknown } };

async function openaiTurn(settings: LLMSettings, req: TurnRequest, thinkingParams: Record<string, unknown> = {}): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const body: Record<string, unknown> = {
		model: settings.model,
		messages: req.messages.map(toOpenAIMessage),
		stream,
		...thinkingParams,
	};
	if (settings.temperature !== undefined) body.temperature = settings.temperature;
	if (settings.maxTokens) body.max_tokens = settings.maxTokens;
	// Para saber cuántos tokens gastó: en streaming el uso solo llega si se pide.
	if (stream) body.stream_options = { include_usage: true };
	if (req.tools?.length) {
		body.tools = req.tools;
		body.tool_choice = "auto";
	}
	const res = await doFetch(settings, `${settings.baseUrl}/chat/completions`, body, req.signal);

	if (!stream) {
		const data = (await res.json()) as {
			choices?: { message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIToolCallDelta[] } }[];
			usage?: OpenAIUsage;
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
			...(msg?.reasoning_content ? { carry: { reasoning_content: msg.reasoning_content } } : {}),
			usage: openaiUsage(data.usage, msg?.reasoning_content ?? ""),
		};
	}

	let content = "";
	let reasoning = "";
	let usage: OpenAIUsage | undefined;
	const calls = new Map<number, { id: string; name: string; args: string }>();
	for await (const line of readLines(res)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		let evt: {
			choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: OpenAIToolCallDelta[] } }[];
			error?: { message?: string };
			usage?: OpenAIUsage | null;
		};
		try {
			evt = JSON.parse(payload);
		} catch {
			continue;
		}
		if (evt.error) throw new LLMError(`Error del modelo: ${evt.error.message ?? "desconocido"}`, "server");
		if (evt.usage) usage = evt.usage;
		const delta = evt.choices?.[0]?.delta;
		if (!delta) continue;
		if (delta.reasoning_content) reasoning += delta.reasoning_content;
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
		...(reasoning ? { carry: { reasoning_content: reasoning } } : {}),
		usage: openaiUsage(usage, reasoning),
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
	message?: { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
	done?: boolean;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
};

async function ollamaTurn(settings: LLMSettings, req: TurnRequest, thinkingParams: Record<string, unknown> = {}): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const options: Record<string, unknown> = { num_ctx: settings.contextWindow };
	if (settings.temperature !== undefined) options.temperature = settings.temperature;
	if (settings.maxTokens) options.num_predict = settings.maxTokens;
	const body: Record<string, unknown> = {
		model: settings.model,
		messages: req.messages.map(toOllamaMessage),
		stream,
		options,
		...thinkingParams,
	};
	if (req.tools?.length) body.tools = req.tools;
	const res = await doFetch(settings, `${settings.baseUrl}/api/chat`, body, req.signal);

	let content = "";
	let thinking = "";
	let usage: TokenUsage | undefined;
	const toolCalls: ToolCallSpec[] = [];
	const absorb = (chunk: OllamaChunk) => {
		if (chunk.error) throw new LLMError(`${PROVIDER_PRESETS[settings.provider].title}: ${chunk.error}`, "server");
		if (chunk.message?.thinking) thinking += chunk.message.thinking;
		// El último trozo trae lo que leyó (prompt_eval_count) y lo que escribió, pensando incluido (eval_count).
		if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
			usage = { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 };
		}
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
	if (usage && thinking) usage.reasoning = Math.min(usage.output, approxTokens(thinking));
	return { content, toolCalls, usage };
}

// ---------- Anthropic (/messages): Claude; en OpenCode también MiniMax y algunos Qwen ----------

type AnthropicBlock = { type: string; [key: string]: unknown };
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };

/** El formato obliga a decir cuánto puede escribir el modelo como máximo. */
const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;
const ANTHROPIC_MAX_TOKENS_CAP = 32_000;

function toAnthropicImage(url: string): AnthropicBlock {
	const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	return m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } };
}

function toAnthropicConversation(messages: Message[]): { system: string; messages: AnthropicMessage[] } {
	const system: string[] = [];
	const out: AnthropicMessage[] = [];
	// Anthropic exige alternar usuario/asistente: los mensajes seguidos del mismo rol se unen en uno.
	const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
		if (!blocks.length) return;
		const last = out[out.length - 1];
		if (last?.role === role) last.content.push(...blocks);
		else out.push({ role, content: [...blocks] });
	};
	for (const m of messages) {
		if (m.role === "system") {
			if (m.content.trim()) system.push(m.content);
		} else if (m.role === "tool") {
			// Los resultados de herramientas viajan como mensaje de usuario.
			push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "(sin resultado)" }]);
		} else if (m.role === "assistant") {
			if (m.anthropic_blocks?.length) {
				push("assistant", m.anthropic_blocks as AnthropicBlock[]);
				continue;
			}
			const blocks: AnthropicBlock[] = [];
			if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
			for (const tc of m.tool_calls ?? []) {
				blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: argsToObject(tc.function.arguments) });
			}
			push("assistant", blocks);
		} else if (Array.isArray(m.content)) {
			const blocks: AnthropicBlock[] = [];
			for (const p of orderParts(m.content)) {
				if (p.type === "image_url") blocks.push(toAnthropicImage(p.image_url.url));
				else if (p.text.trim()) blocks.push({ type: "text", text: p.text });
			}
			push("user", blocks);
		} else if (m.content.trim()) {
			push("user", [{ type: "text", text: m.content }]);
		}
	}
	// La conversación tiene que empezar por el usuario.
	if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(continúa)" }] });
	return { system: system.join("\n\n"), messages: out };
}

type AnthropicEvent = {
	type?: string;
	index?: number;
	content_block?: AnthropicBlock;
	delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string };
	error?: { message?: string };
	message?: { usage?: AnthropicUsage };
	usage?: AnthropicUsage;
};

type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };

/** Lo leído incluye lo que vino de la caché del servidor. */
const anthropicInput = (u: AnthropicUsage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

async function anthropicTurn(settings: LLMSettings, req: TurnRequest): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const conversation = toAnthropicConversation(req.messages);
	const body: Record<string, unknown> = {
		model: settings.model,
		max_tokens: Math.min(settings.maxTokens ?? settings.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS, settings.maxOutputTokens ?? ANTHROPIC_MAX_TOKENS_CAP, ANTHROPIC_MAX_TOKENS_CAP),
		messages: conversation.messages,
		stream,
	};
	if (conversation.system) body.system = conversation.system;
	// En este formato la temperatura va de 0 a 1.
	if (settings.temperature !== undefined) body.temperature = Math.min(settings.temperature, 1);
	if (req.tools?.length) {
		body.tools = req.tools.map((t) => ({
			name: t.function.name,
			description: t.function.description ?? "",
			input_schema: t.function.parameters ?? { type: "object", properties: {} },
		}));
	}
	const res = await doFetch(settings, `${settings.baseUrl}/messages`, body, req.signal);

	let blocks: AnthropicBlock[] = [];
	let usage: TokenUsage | undefined;
	if (!stream) {
		const data = (await res.json()) as { content?: AnthropicBlock[]; usage?: AnthropicUsage };
		blocks = Array.isArray(data.content) ? data.content : [];
		if (data.usage) usage = { input: anthropicInput(data.usage), output: data.usage.output_tokens ?? 0 };
	} else {
		// Cada bloque (texto, razonamiento, uso de herramienta) llega a trozos, identificado por su índice.
		const partial = new Map<number, AnthropicBlock>();
		const inputJson = new Map<number, string>();
		for await (const line of readLines(res)) {
			if (!line.startsWith("data:")) continue;
			let evt: AnthropicEvent;
			try {
				evt = JSON.parse(line.slice(5).trim());
			} catch {
				continue;
			}
			if (evt.type === "error") throw new LLMError(`Error del modelo: ${evt.error?.message ?? "desconocido"}`, "server");
			if (evt.type === "message_stop") break;
			// Lo leído llega al empezar; lo escrito, al final (message_delta).
			if (evt.type === "message_start" && evt.message?.usage) usage = { input: anthropicInput(evt.message.usage), output: evt.message.usage.output_tokens ?? 0 };
			if (evt.type === "message_delta" && evt.usage) usage = { input: usage?.input ?? 0, output: evt.usage.output_tokens ?? usage?.output ?? 0 };
			const index = evt.index ?? 0;
			if (evt.type === "content_block_start" && evt.content_block) {
				partial.set(index, { ...evt.content_block });
				if (evt.content_block.type === "text" && typeof evt.content_block.text === "string" && evt.content_block.text) {
					req.onDelta?.(evt.content_block.text);
				}
				continue;
			}
			const block = partial.get(index);
			const delta = evt.delta;
			if (evt.type !== "content_block_delta" || !block || !delta) continue;
			if (delta.type === "text_delta" && delta.text) {
				block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
				req.onDelta?.(delta.text);
			} else if (delta.type === "input_json_delta") {
				inputJson.set(index, (inputJson.get(index) ?? "") + (delta.partial_json ?? ""));
			} else if (delta.type === "thinking_delta") {
				block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking ?? ""}`;
			} else if (delta.type === "signature_delta") {
				block.signature = `${typeof block.signature === "string" ? block.signature : ""}${delta.signature ?? ""}`;
			}
		}
		for (const [index, json] of inputJson) {
			const block = partial.get(index);
			if (block && json.trim()) block.input = argsToObject(json);
		}
		blocks = [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
	}

	let content = "";
	const toolCalls: ToolCallSpec[] = [];
	const keep: AnthropicBlock[] = [];
	for (const b of blocks) {
		if (b.type === "text") {
			const text = typeof b.text === "string" ? b.text : "";
			content += text;
			if (text.trim()) keep.push({ type: "text", text });
		} else if (b.type === "tool_use" && typeof b.name === "string" && b.name) {
			const id = typeof b.id === "string" && b.id ? b.id : newCallId();
			const input = b.input && typeof b.input === "object" ? b.input : {};
			toolCalls.push({ id, type: "function", function: { name: b.name, arguments: JSON.stringify(input) } });
			keep.push({ type: "tool_use", id, name: b.name, input });
		} else if (b.type === "redacted_thinking" || (b.type === "thinking" && typeof b.signature === "string" && b.signature)) {
			// El razonamiento solo se puede devolver si viene firmado; sin firma el servidor lo rechazaría.
			keep.push(b);
		}
	}
	const thinkingText = blocks.map((b) => (b.type === "thinking" && typeof b.thinking === "string" ? b.thinking : "")).join("");
	if (usage && thinkingText) usage.reasoning = Math.min(usage.output, approxTokens(thinkingText));
	return { content, toolCalls, usage, ...(toolCalls.length ? { carry: { anthropic_blocks: keep } } : {}) };
}

// ---------- OpenAI Responses (/responses): GPT, Grok y Muse en OpenCode ----------

type ResponsesItem = {
	type?: string;
	call_id?: string;
	name?: string;
	arguments?: unknown;
	content?: { type?: string; text?: string }[];
};

function toResponsesInput(messages: Message[]): { instructions: string; input: Record<string, unknown>[] } {
	const system: string[] = [];
	const input: Record<string, unknown>[] = [];
	for (const m of messages) {
		if (m.role === "system") {
			if (m.content.trim()) system.push(m.content);
		} else if (m.role === "tool") {
			input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
		} else if (m.role === "assistant") {
			if (m.content?.trim()) input.push({ role: "assistant", content: m.content });
			for (const tc of m.tool_calls ?? []) {
				input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
			}
		} else if (Array.isArray(m.content)) {
			input.push({
				role: "user",
				content: orderParts(m.content).map((p) =>
					p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.image_url.url },
				),
			});
		} else {
			input.push({ role: "user", content: m.content });
		}
	}
	return { instructions: system.join("\n\n"), input };
}

function readResponsesOutput(output: ResponsesItem[] | undefined): { content: string; toolCalls: ToolCallSpec[] } {
	let content = "";
	const toolCalls: ToolCallSpec[] = [];
	for (const item of output ?? []) {
		if (item.type === "message") {
			for (const part of item.content ?? []) if (part.type === "output_text" && part.text) content += part.text;
		} else if (item.type === "function_call" && item.name) {
			toolCalls.push({
				id: item.call_id || newCallId(),
				type: "function",
				function: { name: item.name, arguments: argsToString(item.arguments) },
			});
		}
	}
	return { content, toolCalls };
}

type ResponsesEvent = {
	type?: string;
	delta?: string;
	item?: ResponsesItem;
	message?: string;
	response?: { output?: ResponsesItem[]; error?: { message?: string } | null; usage?: ResponsesUsage };
	error?: { message?: string };
};

type ResponsesUsage = { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };

function responsesUsage(u: ResponsesUsage | undefined): TokenUsage | undefined {
	if (!u) return undefined;
	const reasoning = u.output_tokens_details?.reasoning_tokens ?? 0;
	return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, ...(reasoning ? { reasoning } : {}) };
}

async function responsesTurn(settings: LLMSettings, req: TurnRequest, thinkingParams: Record<string, unknown> = {}): Promise<TurnResult> {
	const stream = Boolean(req.onDelta);
	const conversation = toResponsesInput(req.messages);
	// store:false = el servidor no guarda la conversación; Shiro la manda entera cada vez.
	const body: Record<string, unknown> = { model: settings.model, input: conversation.input, stream, store: false, ...thinkingParams };
	if (conversation.instructions) body.instructions = conversation.instructions;
	if (settings.temperature !== undefined) body.temperature = settings.temperature;
	if (settings.maxTokens) body.max_output_tokens = settings.maxTokens;
	if (req.tools?.length) {
		body.tools = req.tools.map((t) => ({
			type: "function",
			name: t.function.name,
			description: t.function.description ?? "",
			parameters: t.function.parameters ?? { type: "object", properties: {} },
			strict: false,
		}));
		body.tool_choice = "auto";
	}
	const res = await doFetch(settings, `${settings.baseUrl}/responses`, body, req.signal);

	if (!stream) {
		const data = (await res.json()) as { output?: ResponsesItem[]; error?: { message?: string } | null; usage?: ResponsesUsage };
		if (data.error?.message) throw new LLMError(`Error del modelo: ${data.error.message}`, "server");
		return { ...readResponsesOutput(data.output), usage: responsesUsage(data.usage) };
	}

	let content = "";
	let usage: TokenUsage | undefined;
	const toolCalls: ToolCallSpec[] = [];
	for await (const line of readLines(res)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") break;
		let evt: ResponsesEvent;
		try {
			evt = JSON.parse(payload);
		} catch {
			continue;
		}
		if (evt.type === "error" || evt.type === "response.failed") {
			const message = evt.message ?? evt.error?.message ?? evt.response?.error?.message ?? "desconocido";
			throw new LLMError(`Error del modelo: ${message}`, "server");
		}
		if (evt.type === "response.output_text.delta" && evt.delta) {
			content += evt.delta;
			req.onDelta?.(evt.delta);
		} else if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
			toolCalls.push(...readResponsesOutput([evt.item]).toolCalls);
		} else if (evt.type === "response.completed" || evt.type === "response.incomplete") {
			// Por si el servidor no mandó los trozos: la respuesta final trae todo.
			const final = readResponsesOutput(evt.response?.output);
			if (!content && final.content) {
				content = final.content;
				req.onDelta?.(final.content);
			}
			if (!toolCalls.length) toolCalls.push(...final.toolCalls);
			usage = responsesUsage(evt.response?.usage);
			break;
		}
	}
	return { content, toolCalls, usage };
}
