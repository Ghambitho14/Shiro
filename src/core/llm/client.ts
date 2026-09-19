import type { Message, ToolCallSpec } from "../agent/Types.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { logger } from "../logger.js";
import { LLMError, type ChatOptions, type ExecuteToolFn, type LLMClient, type ToolDef } from "./LLMClient.js";
import { resolveLLMSettings, type LLMSettings } from "./providers.js";
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

/**
 * Cliente único para cualquier proveedor. Se encarga del bucle de herramientas,
 * del streaming y de cambiar a modo texto si el modelo no soporta tools nativas.
 */
export function createLLMClient(resolve: () => LLMSettings = resolveLLMSettings): LLMClient {
	return {
		async chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
			const settings = resolve();
			const filter = opts.onDelta ? new StreamFilter(opts.onDelta) : null;
			const turn = await sendTurn(settings, {
				messages,
				onDelta: filter ? (c) => filter.push(c) : undefined,
				signal: opts.signal,
			});
			filter?.flush();
			return finalText(turn.content);
		},

		async chatWithTools(
			messages: Message[],
			toolsDef: ToolDef[],
			executeTool: ExecuteToolFn,
			opts: ChatOptions = {},
		): Promise<string> {
			if (!toolsDef.length) return this.chat(messages, opts);
			const settings = resolve();
			const toolNames = new Set(toolsDef.map((t) => t.function.name));
			let textMode = settings.toolMode === "text" || textModeModels.has(modelKey(settings));
			let msgs = textMode ? withTextToolInstructions(messages, toolsDef) : [...messages];
			let emittedText = false;
			const maxIterations = getMaxToolIterations();

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
					turn = await sendTurn(settings, {
						messages: msgs,
						tools: textMode ? undefined : toolsDef,
						onDelta: filter ? (c) => filter.push(c) : undefined,
						signal: opts.signal,
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
				for (const call of calls) {
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
				}

				if (textMode) {
					msgs.push({ role: "assistant", content: turn.content });
					msgs.push({ role: "user", content: results.map((r) => formatTextToolResult(r.call.function.name, r.content)).join("\n\n") });
				} else {
					msgs.push({ role: "assistant", content: turn.content || "", tool_calls: calls });
					for (const r of results) {
						msgs.push({ role: "tool", tool_call_id: r.call.id, name: r.call.function.name, content: r.content });
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
