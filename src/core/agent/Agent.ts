import type { Message, ContentPart } from "./Types.js";
import { getMessagePreview } from "./contentUtils.js";
import type { AgentEvent } from "./Types.js";
import type { LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import {
	executeToolSafeScoped,
	getToolsDefinitionScoped,
} from "../tools/ToolRegistry.js";

import { checkAndIntervene } from "../health/HealthManager.js";
import { logger } from "../logger.js";
import {
	sanitizeModelResponse,
	isMeaningfulResponse,
	FALLBACK_EMPTY_RESPONSE,
} from "../sanitizeResponse.js";
import { createRetryPolicy, getBackoffMs, isRetryableError } from "../health/RetryPolicy.js";

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
};

function getUserFacingInterventionMessage(): string {
	return "Algo salió mal al procesar. Puedes reformular o intentar de nuevo.";
}

function getFallbackResponse(goal: string, error?: string): string {
	const lower = goal.toLowerCase();
	const isSpanish = /[áéíóúñ¿¡]/i.test(goal);
	
	if (error) {
		logger.warn("LLM fallback activado", { error: error.slice(0, 100) });
	}
	
	if (isSpanish) {
		if (/\b(hola|hey|hi|buenas)\b/i.test(lower)) return "¡Hola! ¿En qué puedo ayudarte?";
		if (/\b(gracias|thanks)\b/i.test(lower)) return "¡De nada! ¿Hay algo más en lo que pueda ayudarte?";
		if (/\b(bye|adios|chau|nos vemos)\b/i.test(lower)) return "¡Hasta luego! Que te vaya bien.";
		if (/\b(como estas|cómo estás)\b/i.test(lower)) return "Estoy bien, gracias por preguntar. ¿Y tú?";
		if (/\b(que puedes hacer|qué puedes hacer)\b/i.test(lower)) return "Puedo leer y escribir archivos, buscar en internet, hacer cálculos, y chatear contigo.";
		if (/\b(quien eres|quién eres|que eres)\b/i.test(lower)) return "Soy Shiro, un asistente de IA.";
		return "Disculpa, tuve un problema. ¿Podrías intentarlo de nuevo?";
	}
	
	if (/\b(hi|hello|hey)\b/i.test(lower)) return "Hi! How can I help you?";
	if (/\b(thanks|thank you)\b/i.test(lower)) return "You're welcome!";
	if (/\b(bye|goodbye)\b/i.test(lower)) return "Goodbye!";
	if (/\b(how are you)\b/i.test(lower)) return "I'm doing well, thanks!";
	if (/\b(what can you do)\b/i.test(lower)) return "I can read/write files, search the web, do calculations, and chat.";
	if (/\b(who are you|what are you)\b/i.test(lower)) return "I'm Shiro, an AI assistant.";
	return "Sorry, I had trouble. Could you try again?";
}

/** Loop principal: simple como OpenClaw. El LLM decide. */
export async function runAgent(
	goal: string,
	opts: AgentOptions,
	workspaceContext?: string,
): Promise<string> {
	const {
		llm,
		memory,
		agentName,
		tokenBudget = 8000,
		textOnly = false,
		allowedTools,
		explainMode = "off",
		conversation,
		userProfile,
	} = opts;

	const wantExplain = (() => {
		const t = (goal || "").toLowerCase();
		return /\b(explica|explicame|explícame|que hiciste|qué hiciste|como lo hiciste|cómo lo hiciste|pasos|tools|herramientas)\b/i.test(t);
	})();

	const effectiveExplainMode: "off" | "brief" | "on" =
		wantExplain && explainMode === "off" ? "brief" : explainMode;

	const runId = `run_${Date.now()}`;

	const pushEvent = (type: AgentEvent["type"], payload: Record<string, unknown>, stepId?: string) => {
		memory.push({
			type,
			timestamp: new Date().toISOString(),
			runId,
			stepId,
			payload,
		});
	};

	pushEvent("decision", { goal });

	const recent = memory.getRecent(20);
	const { intervened, action } = checkAndIntervene(recent);
	if (intervened && action) {
		logger.warn("HealthManager intervino", { action });
		pushEvent("error", { content: action });
		return getUserFacingInterventionMessage();
	}

	const { system, messages } = buildContext({
		goal,
		agentName,
		shortMemory: memory,
		tokenBudget,
		workspaceContext,
		textOnly,
		userProfile: userProfile ?? undefined,
	});

	const normalizedConversation = Array.isArray(conversation)
		? conversation
			.map((m) => ({ role: m.role, content: m.content ?? "" }))
			.filter((m) => {
				if (m.role !== "user" && m.role !== "assistant") return false;
				const preview = getMessagePreview(m.content);
				const hasImage = Array.isArray(m.content) && m.content.some((p: ContentPart) => p.type === "image_url");
				return preview.length > 0 || hasImage;
			})
		: [];

	const fullMessages: Message[] = normalizedConversation.length > 0
		? [{ role: "system", content: system }, ...normalizedConversation]
		: [{ role: "system", content: system }, ...messages];

	const toolsDef = getToolsDefinitionScoped(allowedTools);
	const retryPolicy = createRetryPolicy({ maxRetries: 3, baseDelayMs: 500 });

	type ToolCallTrace = { name: string; ok: boolean; argsKeys: string[] };
	const usedTools: ToolCallTrace[] = [];

	function safeArgsKeys(args: Record<string, unknown>): string[] {
		try {
			return Object.keys(args ?? {}).slice(0, 12);
		} catch {
			return [];
		}
	}

	function buildToolExplanation(): string {
		if (effectiveExplainMode === "off") return "";
		if (!usedTools.length) return "";
		const uniq: ToolCallTrace[] = [];
		const seen = new Set<string>();
		for (const t of usedTools) {
			if (seen.has(t.name)) continue;
			seen.add(t.name);
			uniq.push(t);
		}
		if (effectiveExplainMode === "brief") {
			return `\n\nNota: usé herramientas (${uniq.map((t) => t.name).join(", ")}).`;
		}
		if (effectiveExplainMode !== "on") return "";
		const lines = uniq.map((t) => {
			const keys = t.argsKeys.length ? ` args: ${t.argsKeys.join(", ")}` : "";
			const status = t.ok ? "ok" : "falló";
			return `- ${t.name} (${status})${keys}`;
		});
		return `\n\nHerramientas usadas:\n${lines.join("\n")}`;
	}

	const adaptToolResult = async (
		name: string,
		args: Record<string, unknown>,
	): Promise<{ ok: boolean; content: string; error?: string }> => {
		logger.info(`🔧 Tool: ${name}`);
		pushEvent("tool_call", { name, argsKeys: safeArgsKeys(args) });
		let lastError: string | undefined;
		for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
			const r = await executeToolSafeScoped(name, args, allowedTools);
			usedTools.push({ name, ok: r.ok, argsKeys: safeArgsKeys(args) });
			if (r.ok) {
				return { ok: true, content: r.content };
			}
			lastError = r.error;
			logger.warn(`❌ Tool ${name} falló:`, lastError);
			const retryable = isRetryableError({ retryable: true, message: r.error ?? "" });
			if (attempt < retryPolicy.maxRetries && retryable.retryable) {
				const delay = getBackoffMs(retryPolicy, attempt);
				await new Promise((resolve) => setTimeout(resolve, delay));
			} else {
				break;
			}
		}
		return { ok: false, content: "", error: lastError };
	};

	// Simple: chat directo con tools
	try {
		let content = "";
		for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
			try {
				content = textOnly
					? (await llm.chat(fullMessages)).trim()
					: (await llm.chatWithTools(fullMessages, toolsDef, adaptToolResult)).trim();
				break;
			} catch (err) {
				const retryable = isRetryableError(err);
				if (attempt < retryPolicy.maxRetries && retryable.retryable) {
					const delay = getBackoffMs(retryPolicy, attempt);
					logger.warn(`LLM falló, reintentando en ${delay}ms`);
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					throw err;
				}
			}
		}
		const out = sanitizeModelResponse(content || "");
		pushEvent("observation", { content: out });
		const finalText = isMeaningfulResponse(out) ? out : FALLBACK_EMPTY_RESPONSE;
		return finalText + buildToolExplanation();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushEvent("error", { content: msg });
		return getFallbackResponse(goal, msg);
	}
}
