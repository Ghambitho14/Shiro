import type { Message } from "./Types.js";
import type { AgentEvent } from "./Types.js";
import type { LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import { plan } from "./Planner.js";
import { executeStep } from "./Executor.js";
import {
	executeToolSafeScoped,
	getToolsDefinitionScoped,
} from "../tools/ToolRegistry.js";

import { checkAndIntervene } from "../health/HealthManager.js";
import { policies } from "../soul/policies.js";
import { logger } from "../logger.js";
import {
	sanitizeModelResponse,
	isMeaningfulResponse,
	FALLBACK_EMPTY_RESPONSE,
} from "../sanitizeResponse.js";

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
	usePlanner?: boolean;
	textOnly?: boolean;
	allowedTools?: string[];
	conversation?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Perfil del usuario (para personalizar respuestas). */
	userProfile?: UserProfileForAgent | null;
};

/** Mensaje genérico al usuario cuando hay intervención interna (loop, safe_mode). No exponer detalles técnicos. */
function getUserFacingInterventionMessage(): string {
	return "Algo salió mal al procesar. Puedes reformular o intentar de nuevo.";
}

/** Deduplica pasos consecutivos idénticos del planner para evitar ejecutar el mismo paso varias veces. */
function dedupeConsecutiveSteps(steps: string[]): string[] {
	const out: string[] = [];
	let prev = "";
	for (const s of steps) {
		const t = s.trim();
		if (t && t !== prev) {
			out.push(t);
			prev = t;
		}
	}
	return out;
}

/** Longitud máxima de texto para considerar "conversación simple" (evitar planner/tools). */
const SIMPLE_INTENT_MAX_LENGTH = 120;

/**
 * Detecta intents conversacionales simples que no requieren plan ni herramientas:
 * saludos, identidad, capacidades, small talk, aclaraciones cortas.
 * Estos se enrutan a la ruta directa (solo llm.chat) para reducir fallos y latencia.
 */
function isSimpleConversationalIntent(goal: string): boolean {
	const t = goal.trim().toLowerCase().replace(/\s+/g, " ");
	if (t.length > SIMPLE_INTENT_MAX_LENGTH) return false;

	// Mensajes muy cortos que no piden acciones con archivos (ej. "2+2", "hola", "qué hora es")
	if (t.length <= 25) {
		const fileOps = /\b(lee|leer|escribe|escribir|archivo|file|listar|list_dir|read_file|write_file)\b/i.test(t);
		if (!fileOps) return true;
	}

	// Saludos
	if (
		t.length < 80 &&
		(/^(hola|hey|hi|buenas|qué tal|qué hubo|hello|saludos|buen día|buenas tardes|buenas noches)[\s!?.,]*$/i.test(t) ||
			/^((hola|hey|hi),?\s*)+[!.]?\s*$/i.test(t))
	) {
		return true;
	}

	// Preguntas de identidad
	if (/\b(quien eres|quién eres|qué eres|who are you|what are you|como te llamas|cuál es tu nombre|cómo te llamas)\b/i.test(t)) return true;
	if (/^(quien eres|quién eres|que eres|who are you|what are you)\s*[?.!]*$/i.test(t)) return true;

	// Preguntas de capacidades
	if (/\b(qué puedes hacer|que puedes hacer|qué sabes hacer|what can you do|qué haces|para qué sirves)\b/i.test(t)) return true;
	if (/^(que puedes hacer|qué puedes hacer|que sabes hacer|what can you do)\s*[?.!]*$/i.test(t)) return true;

	// Preguntas sobre acceso/conectividad (cualquier orden: "acceso a internet tienes?", "tienes internet?")
	if (t.length <= 55 && /internet/.test(t) && /(acceso|tienes|tiene|conexión|conexion)/i.test(t)) return true;
	if (/\b(tienes acceso a internet|tiene acceso a internet|do you have internet|tienes conexión|tienes internet|tienes acceso a la red)\b/i.test(t)) return true;

	// Preguntas de fecha/día (incl. con prefijo "oye", "hey")
	if (/\b(que dia es hoy|qué día es hoy|qué fecha es|fecha de hoy|what day is it|what.?s the date)\b/i.test(t)) return true;
	if (t.length <= 35 && /(que dia|qué día|qué fecha|what day)/i.test(t)) return true;

	// Meta / qué pasó (aclaración corta)
	if (/\b(qué pasó|que paso|what happened|qué pasó)\b/i.test(t) && t.length <= 35) return true;

	// Small talk / cortos
	if (/^(cómo estás|como estas|como va|qué tal estás|how are you)\s*[?.!]*$/i.test(t)) return true;

	// Aclaraciones muy cortas
	if (t.length <= 25 && /^(qué|que|perdón|perdon|no entendí|no entiendo|a qué te refieres|explícame)\s*[?.!]*$/i.test(t)) return true;

	return false;
}

/** Loop principal: opción con planner (pasos) o directo (un solo chatWithTools). */
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
		usePlanner = false,
		textOnly = false,
		allowedTools,
		conversation,
		userProfile,
	} = opts;

	const runId = `run_${Date.now()}`;

	const useDirectConversationPath = isSimpleConversationalIntent(goal);
	const effectiveUsePlanner = usePlanner && !useDirectConversationPath;
	const effectiveTextOnly = textOnly || useDirectConversationPath;

	const pushEvent = (type: AgentEvent["type"], payload: Record<string, unknown>, stepId?: string) => {
		memory.push({
			type,
			timestamp: new Date().toISOString(),
			runId,
			stepId,
			payload,
		});
	};

	pushEvent("decision", { goal, usePlanner: effectiveUsePlanner });

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
		workspaceContext: useDirectConversationPath ? undefined : workspaceContext,
		textOnly: effectiveTextOnly,
		userProfile: userProfile ?? undefined,
	});

	const normalizedConversation = Array.isArray(conversation)
		? conversation
			.map((m) => ({ role: m.role, content: m.content?.trim() ?? "" }))
			.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.length > 0)
		: [];
	const fullMessages: Message[] = normalizedConversation.length > 0
		? [{ role: "system", content: system }, ...normalizedConversation]
		: [{ role: "system", content: system }, ...messages];
	const toolsDef = getToolsDefinitionScoped(allowedTools);
	const adaptToolResult = (
		name: string,
		args: Record<string, unknown>,
	): { ok: boolean; content: string; error?: string } => {
		const r = executeToolSafeScoped(name, args, allowedTools);
		return {
			ok: r.ok,
			content: r.ok ? r.content : r.error,
			error: r.ok ? undefined : r.error,
		};
	};

	if (effectiveUsePlanner && policies.maxStepsPerRun > 0) {
		const rawSteps = await plan(llm, goal, agentName);
		const steps = dedupeConsecutiveSteps(rawSteps);
		logger.info("Plan generado", { raw: rawSteps.length, deduped: steps.length });
		pushEvent("plan", { steps });
		let lastContent = "";
		for (let i = 0; i < Math.min(steps.length, policies.maxStepsPerRun); i++) {
			const stepGoal = steps[i];
			const stepId = `step_${i}`;
			pushEvent("tool_call", { name: "planner_step", step: stepGoal }, stepId);
			const result = await executeStep(llm, stepGoal, fullMessages, adaptToolResult, toolsDef);
			if (!result.ok) {
				pushEvent("error", { content: result.error }, stepId);
				return getUserFacingInterventionMessage();
			}
			lastContent = result.content;
			fullMessages.push({ role: "user", content: stepGoal });
			fullMessages.push({ role: "assistant", content: result.content });
			pushEvent("observation", { content: result.content }, stepId);

			const recent = memory.getRecent(20);
			const { intervened, action } = checkAndIntervene(recent);
			if (intervened && action) {
				logger.warn("HealthManager intervino en bucle planner", { action });
				pushEvent("error", { content: action });
				return getUserFacingInterventionMessage();
			}
		}
		const sanitized = sanitizeModelResponse(lastContent);
		return isMeaningfulResponse(sanitized) ? sanitized : FALLBACK_EMPTY_RESPONSE;
	}

	// Modo directo: conversación simple o sin planner → chat solo texto cuando effectiveTextOnly; si no, chatWithTools
	try {
		const content = effectiveTextOnly
			? (await llm.chat(fullMessages)).trim()
			: (await llm.chatWithTools(fullMessages, toolsDef, adaptToolResult)).trim();
		const out = sanitizeModelResponse(content || "");
		pushEvent("observation", { content: out });
		return isMeaningfulResponse(out) ? out : FALLBACK_EMPTY_RESPONSE;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushEvent("error", { content: msg });
		throw err;
	}
}
