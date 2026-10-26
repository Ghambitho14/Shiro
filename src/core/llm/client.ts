import type { Message, ToolCallSpec } from "../agent/Types.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { logger } from "../logger.js";
import { LLMError, type ChatOptions, type ExecuteToolFn, type LLMClient, type ToolDef } from "./LLMClient.js";
import { prepareLLM, resolveLLMSettings, type LLMSettings, type ModelRef } from "./providers.js";
import { acquireModel, gateTarget } from "./modelGate.js";
import { sendTurn } from "./transports.js";
import { StreamFilter } from "./streamFilter.js";
import { buildTextToolInstructions, formatTextToolResult, parseTextToolCalls, stripToolCalls } from "./textTools.js";
import { getMaxToolIterations, normalizeToolResult } from "./toolRuntime.js";

/** Modelos que ya rechazaron tools nativas en esta ejecución: se usan en modo texto. */
const textModeModels = new Set<string>();
const modelKey = (s: LLMSettings) => `${s.provider}|${s.baseUrl}|${s.model}`;

function withTextToolInstructions(messages: Message[], tools: ToolDef[]): Message[] {
	const instructions = buildTextToolInstructions(tools);
	const idx = messages.findIndex((m) => m.role === "system");
	if (idx < 0) return [{ role: "system", content: instructions }, ...messages];
	const out = [...messages];
	out[idx] = { role: "system", content: `${messages[idx].content as string}\n\n${instructions}` };
	return out;
}

function finalText(raw: string): string {
	return sanitizeModelResponse(stripToolCalls(raw)).trim();
}

const OLD_IMAGE_NOTE = "[imagen anterior omitida para ahorrar contexto]";

/** Deja solo la última imagen devuelta por tools: cada captura ocupa mucho contexto. */
function dropOldToolImages(msgs: Message[], toolImageMsgs: Set<Message>): void {
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		if (!toolImageMsgs.has(m) || m.role !== "user" || !Array.isArray(m.content)) continue;
		const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
		msgs[i] = { role: "user", content: [...text, OLD_IMAGE_NOTE].join("\n") };
		toolImageMsgs.delete(m);
	}
}

function withImages(text: string, images: string[]): Message {
	return {
		role: "user",
		content: [{ type: "text", text }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))],
	};
}

type Real = {
	/** Descarga el catálogo de modelos (OpenCode) o abre el llama.cpp integrado con el modelo. */
	prepare: (signal?: AbortSignal) => Promise<void>;
	/** Turno en el "un solo modelo a la vez" (ver modelGate.ts). */
	gate: boolean;
};

/**
 * Cliente único para cualquier proveedor. Se encarga del bucle de herramientas,
 * del streaming y de cambiar a modo texto si el modelo no soporta tools nativas.
 * Con un `resolve` propio (pruebas) no prepara nada ni espera turno.
 */
export function createLLMClient(resolve: () => LLMSettings = resolveLLMSettings): LLMClient {
	return buildClient(resolve, resolve === resolveLLMSettings ? { prepare: (signal) => prepareLLM(signal), gate: true } : null);
}

/** Cliente para el modelo de un agente (otro proveedor o modelo que el de Ajustes → Modelo). */
export function createLLMClientFor(ref: ModelRef): LLMClient {
	return buildClient(() => resolveLLMSettings(ref), { prepare: (signal) => prepareLLM(signal, ref), gate: true }, ref);
}

function buildClient(resolve: () => LLMSettings, real: Real | null, ref?: ModelRef): LLMClient {
	const prepare = real?.prepare ?? (async () => {});
	/**
	 * Espera turno, deja listo el modelo y devuelve su configuración y cómo soltar el turno.
	 * Se hace en cada vuelta: mientras corren las herramientas otro agente pudo usar otro modelo.
	 */
	const begin = async (signal?: AbortSignal): Promise<{ settings: LLMSettings; release: () => void }> => {
		const release = real?.gate ? await acquireModel(gateTarget(resolve()), signal) : () => {};
		try {
			await prepare(signal);
			return { settings: resolve(), release };
		} catch (err) {
			release();
			throw err;
		}
	};
	return {
		async chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
			const { settings, release } = await begin(opts.signal);
			try {
				const filter = opts.onDelta ? new StreamFilter(opts.onDelta) : null;
				const turn = await sendTurn(settings, {
					messages,
					onDelta: filter ? (c) => filter.push(c) : undefined,
					signal: opts.signal,
					sessionId: opts.sessionId,
				});
				filter?.flush();
				return finalText(turn.content);
			} finally {
				release();
			}
		},

		async chatWithTools(
			messages: Message[],
			toolsDef: ToolDef[],
			executeTool: ExecuteToolFn,
			opts: ChatOptions = {},
		): Promise<string> {
			if (!toolsDef.length) return this.chat(messages, opts);
			let { settings, release } = await begin(opts.signal);
			release();
			const toolNames = new Set(toolsDef.map((t) => t.function.name));
			let textMode = settings.toolMode === "text" || textModeModels.has(modelKey(settings));
			let msgs = textMode ? withTextToolInstructions(messages, toolsDef) : [...messages];
			let emittedText = false;
			const maxIterations = getMaxToolIterations(ref);
			const toolImageMsgs = new Set<Message>();

			for (let i = 0; i < maxIterations; i++) {
				// Separar con una línea en blanco el texto de cada vuelta (solo si la nueva trae texto).
				let needSeparator = emittedText;
				const filter = opts.onDelta
					? new StreamFilter((c) => {
							if (!c) return;
							if (!emittedText && !c.trim()) return;
							if (needSeparator) {
								opts.onDelta!("\n\n");
								needSeparator = false;
							}
							emittedText = true;
							opts.onDelta!(c);
						})
					: null;

				let turn;
				try {
					({ settings, release } = await begin(opts.signal));
					turn = await sendTurn(settings, {
						messages: msgs,
						tools: textMode ? undefined : toolsDef,
						onDelta: filter ? (c) => filter.push(c) : undefined,
						signal: opts.signal,
						sessionId: opts.sessionId,
					});
				} catch (err) {
					if (err instanceof LLMError && err.kind === "tools_unsupported" && !textMode && settings.toolMode === "auto") {
						logger.warn(`${settings.model} no soporta tools nativas; usando modo texto.`);
						textModeModels.add(modelKey(settings));
						textMode = true;
						msgs = withTextToolInstructions(msgs, toolsDef);
						i--;
						continue;
					}
					throw err;
				} finally {
					release();
				}
				filter?.flush();

				let calls: ToolCallSpec[] = turn.toolCalls;
				// Algunos modelos locales escriben <tool_call> en el texto aunque haya tools nativas.
				if (!calls.length && (textMode || turn.content.includes("<tool_call>"))) {
					calls = parseTextToolCalls(turn.content, toolNames).map((c, n) => ({
						id: `text_${i}_${n}`,
						type: "function" as const,
						function: { name: c.name, arguments: JSON.stringify(c.args) },
					}));
				}

				if (!calls.length) return finalText(turn.content);

				// Secuencial: las tools pueden pedir confirmación al usuario o tener efectos.
				const results: { call: ToolCallSpec; content: string }[] = [];
				const images: string[] = [];
				for (const call of calls) {
					if (opts.signal?.aborted) throw new LLMError("Respuesta detenida por el usuario.", "cancelled");
					let args: Record<string, unknown> = {};
					try {
						const parsed = JSON.parse(call.function.arguments || "{}");
						if (parsed && typeof parsed === "object") args = parsed;
					} catch {
						results.push({ call, content: "Error: los argumentos no son JSON válido. Vuelve a intentarlo con JSON correcto." });
						continue;
					}
					const r = await executeTool(call.function.name, args);
					results.push({ call, content: normalizeToolResult(r.ok ? r.content : `Error: ${r.error ?? "desconocido"}`) });
					if (r.ok && r.image) images.push(r.image);
				}

				// Las imágenes (capturas) van en un mensaje de usuario: los mensajes "tool" solo admiten texto.
				if (images.length) dropOldToolImages(msgs, toolImageMsgs);
				if (textMode) {
					msgs.push({ role: "assistant", content: turn.content });
					const text = results.map((r) => formatTextToolResult(r.call.function.name, r.content)).join("\n\n");
					const msg: Message = images.length ? withImages(text, images) : { role: "user", content: text };
					if (images.length) toolImageMsgs.add(msg);
					msgs.push(msg);
				} else {
					// `carry` solo vale si las tool calls son las nativas del modelo (no las leídas del texto).
				msgs.push({ role: "assistant", content: turn.content || "", tool_calls: calls, ...(turn.toolCalls.length ? turn.carry : undefined) });
					for (const r of results) {
						msgs.push({ role: "tool", tool_call_id: r.call.id, name: r.call.function.name, content: r.content });
					}
					if (images.length) {
						const msg = withImages("Imagen devuelta por la herramienta (captura de pantalla):", images);
						toolImageMsgs.add(msg);
						msgs.push(msg);
					}
				}
			}

			// Se acabaron las rondas: pedir una respuesta final con lo que ya tiene.
			msgs.push({
				role: "user",
				content: "Llegaste al límite de herramientas. Responde ahora al usuario con la información que ya tienes, sin usar más herramientas.",
			});
			return this.chat(msgs, opts);
		},

		getConfig() {
			const s = resolve();
			return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, local: s.local };
		},
	};
}
