import type { Message, ContentPart, AgentEvent } from "./Types.js";
import { getMessagePreview } from "./contentUtils.js";
import { LLMError, type LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import { executeToolSafeScoped, getToolsDefinitionScoped, LITE_TOOLS } from "../tools/ToolRegistry.js";
import { logger } from "../logger.js";
import { isMeaningfulResponse, FALLBACK_EMPTY_RESPONSE } from "../sanitizeResponse.js";
import { createRetryPolicy, getBackoffMs, isRetryableError } from "../health/RetryPolicy.js";
import { getDecisionLogger, type DecisionEvent } from "./DecisionLogger.js";
import { getConfig } from "../../config/config.js";
import { getAllowedTools, type Role } from "../roles/roleManager.js";
import { runWithApprover, type Approver } from "../tools/approval.js";

export type UserProfileForAgent = {
	userName?: string;
	language?: string;
	about?: string;
	extra?: string;
};

export type AgentOptions = {
	llm: LLMClient;
	memory: MemoryStore;
	agentName: string;
	tokenBudget?: number;
	textOnly?: boolean;
	allowedTools?: string[];
	/**
	 * Explicación de herramientas usadas en la respuesta.
	 * - off: nunca
	 * - brief: una línea corta si se usaron tools
	 * - on: lista corta de tools usadas
	 */
	explainMode?: "off" | "brief" | "on";
	conversation?: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
	userProfile?: UserProfileForAgent | null;
	/** Recibe el texto a medida que el modelo lo genera (streaming real). */
	onStreamDelta?: (chunk: string) => void;
	role?: Role;
	/**
	 * Quién aprueba las acciones peligrosas (exec, escribir archivos…).
	 * Sin approver, con approvalMode "ask" esas acciones se bloquean.
	 */
	approver?: Approver;
};

/** Veces que se permite repetir exactamente la misma llamada (nombre + args) en una respuesta. */
const MAX_IDENTICAL_TOOL_CALLS = 2;

/** Mensaje para el usuario cuando el modelo falla: dice qué pasó en vez de ocultarlo. */
function describeFailure(err: unknown): string {
	if (err instanceof LLMError) return `⚠️ ${err.message}`;
	const msg = err instanceof Error ? err.message : String(err);
	return `⚠️ Error al hablar con el modelo: ${msg.slice(0, 300)}`;
}

/**
 * Qué herramientas ve el modelo: las del rol, recortadas a las esenciales si el
 * perfil es "lite" (por defecto con modelos locales, que se confunden con muchas tools).
 */
function resolveTools(role: Role, requested: string[] | undefined, localModel: boolean): string[] | undefined {
	let tools = getAllowedTools(role) ?? requested;
	if (tools && requested) {
		const req = new Set(requested);
		tools = tools.filter((t) => req.has(t));
	}
	const profile = getConfig().toolProfile;
	const lite = profile === "lite" || (profile === "auto" && localModel && role === "default");
	if (lite) {
		tools = (tools ?? LITE_TOOLS).filter((t) => LITE_TOOLS.includes(t));
	}
	return tools;
}

export async function runAgent(goal: string, opts: AgentOptions, workspaceContext?: string): Promise<string> {
	const {
		llm,
		memory,
		agentName,
		tokenBudget = 8000,
		allowedTools,
		explainMode = "off",
		conversation,
		userProfile,
		onStreamDelta,
		role: roleOverride,
		approver,
	} = opts;

	const role: Role = roleOverride ?? getConfig().role ?? "default";
	const effectiveTools = resolveTools(role, allowedTools, llm.getConfig().local);
	// Una lista vacía significa "ninguna tool": se responde solo con texto.
	const textOnly = opts.textOnly === true || (effectiveTools !== undefined && effectiveTools.length === 0);

	const wantExplain = /\b(explica|explicame|explícame|que hiciste|qué hiciste|como lo hiciste|cómo lo hiciste|pasos|tools|herramientas)\b/i.test(goal || "");
	const effectiveExplainMode = wantExplain && explainMode === "off" ? "brief" : explainMode;

	const runId = `run_${Date.now()}`;
	const decisionLogger = getDecisionLogger();
	const pushEvent = (type: AgentEvent["type"], payload: Record<string, unknown>) => {
		const timestamp = new Date().toISOString();
		memory.push({ type, timestamp, runId, payload });
		decisionLogger.log({
			type: type as DecisionEvent["type"],
			goal: payload.goal as string,
			content: payload.content as string,
			name: payload.name as string,
			argsKeys: payload.argsKeys as string[],
			timestamp,
			runId,
		} as DecisionEvent);
	};

	pushEvent("decision", { goal });

	const { system, messages } = buildContext({
		goal,
		agentName,
		shortMemory: memory,
		tokenBudget,
		workspaceContext,
		textOnly,
		userProfile: userProfile ?? undefined,
		role,
	});

	const history: Message[] = (conversation ?? [])
		.filter((m) => {
			if (m.role !== "user" && m.role !== "assistant") return false;
			const hasImage = Array.isArray(m.content) && m.content.some((p) => p.type === "image_url");
			return getMessagePreview(m.content ?? "").length > 0 || hasImage;
		})
		.map((m): Message =>
			m.role === "user"
				? { role: "user", content: m.content ?? "" }
				: { role: "assistant", content: typeof m.content === "string" ? m.content : getMessagePreview(m.content) },
		);

	const fullMessages: Message[] = [{ role: "system", content: system }, ...(history.length ? history : messages)];
	const toolsDef = getToolsDefinitionScoped(effectiveTools);

	const usedTools: { name: string; ok: boolean; argsKeys: string[] }[] = [];
	const callCounts = new Map<string, number>();

	const executeTool = async (name: string, args: Record<string, unknown>) => {
		const argsKeys = Object.keys(args ?? {}).slice(0, 12);
		logger.info(`🔧 Tool: ${name}`);
		pushEvent("tool_call", { name, argsKeys });

		// Anti-bucle: los modelos pequeños a veces repiten la misma llamada sin fin.
		const signature = `${name}:${JSON.stringify(args)}`;
		const count = (callCounts.get(signature) ?? 0) + 1;
		callCounts.set(signature, count);
		if (count > MAX_IDENTICAL_TOOL_CALLS) {
			return {
				ok: false,
				content: "",
				error: `Ya llamaste a ${name} con estos mismos argumentos ${count - 1} veces. Usa el resultado anterior o responde al usuario.`,
			};
		}

		const r = await executeToolSafeScoped(name, args, effectiveTools);
		usedTools.push({ name, ok: r.ok, argsKeys });
		if (!r.ok) logger.warn(`❌ Tool ${name} falló: ${r.error}`);
		return r.ok ? { ok: true, content: r.content } : { ok: false, content: "", error: r.error };
	};

	// Solo se reintenta la llamada al modelo, nunca las tools (podrían tener efectos).
	let streamed = false;
	const onDelta = onStreamDelta
		? (chunk: string) => {
				streamed = true;
				onStreamDelta(chunk);
			}
		: undefined;
	const retryPolicy = createRetryPolicy({ maxRetries: 2, baseDelayMs: 800 });
	let content = "";
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				content = await runWithApprover(approver, () =>
					textOnly
						? llm.chat(fullMessages, { onDelta })
						: llm.chatWithTools(fullMessages, toolsDef, executeTool, { onDelta }),
				);
				break;
			} catch (err) {
				const retryable = err instanceof LLMError ? err.retryable : isRetryableError(err).retryable;
				// Si ya se mostró texto en streaming, reintentar lo duplicaría.
				if (!retryable || attempt >= retryPolicy.maxRetries || usedTools.length > 0 || streamed) throw err;
				const delay = getBackoffMs(retryPolicy, attempt);
				logger.warn(`El modelo falló, reintento en ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error("Fallo del modelo", { error: message.slice(0, 300) });
		pushEvent("error", { content: message });
		return describeFailure(err);
	}

	pushEvent("observation", { content });
	const finalText = isMeaningfulResponse(content) ? content : FALLBACK_EMPTY_RESPONSE;
	return finalText + buildToolExplanation(usedTools, effectiveExplainMode);
}

function buildToolExplanation(used: { name: string; ok: boolean; argsKeys: string[] }[], mode: "off" | "brief" | "on"): string {
	if (mode === "off" || !used.length) return "";
	const unique = [...new Map(used.map((t) => [t.name, t])).values()];
	if (mode === "brief") return `\n\nNota: usé herramientas (${unique.map((t) => t.name).join(", ")}).`;
	const lines = unique.map((t) => `- ${t.name} (${t.ok ? "ok" : "falló"})${t.argsKeys.length ? ` args: ${t.argsKeys.join(", ")}` : ""}`);
	return `\n\nHerramientas usadas:\n${lines.join("\n")}`;
}
