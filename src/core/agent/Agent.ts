import type { Message, ContentPart } from "./Types.js";
import { getMessagePreview } from "./contentUtils.js";
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
import { verifyGoal } from "./Verifier.js";
import { createRetryPolicy, getBackoffMs, shouldRetry, isRetryableError } from "../health/RetryPolicy.js";

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
	conversation?: Array<{ role: "user" | "assistant"; content: string | ContentPart[] }>;
	/** Perfil del usuario (para personalizar respuestas). */
	userProfile?: UserProfileForAgent | null;
};

/** Mensaje genérico al usuario cuando hay intervención interna (loop, safe_mode). No exponer detalles técnicos. */
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
		if (/\b(que puedes hacer|qué puedes hacer)\b/i.test(lower)) return "Puedo leer y escribir archivos, buscar en internet, hacer cálculos, mostrar imágenes, y chatear contigo.";
		if (/\b(quien eres|quién eres|que eres)\b/i.test(lower)) return "Soy Shiro, un asistente de IA. Estoy aquí para ayudarte con lo que necesites.";
		return "Disculpa, tuve un problema al procesar tu solicitud. ¿Podrías intentarlo de nuevo?";
	}
	
	if (/\b(hi|hello|hey|good morning)\b/i.test(lower)) return "Hi! How can I help you?";
	if (/\b(thanks|thank you)\b/i.test(lower)) return "You're welcome! Anything else I can help with?";
	if (/\b(bye|goodbye|see you)\b/i.test(lower)) return "Goodbye! Take care.";
	if (/\b(how are you)\b/i.test(lower)) return "I'm doing well, thanks for asking. How about you?";
	if (/\b(what can you do)\b/i.test(lower)) return "I can read and write files, search the web, do calculations, view images, and chat with you.";
	if (/\b(who are you|what are you)\b/i.test(lower)) return "I'm Shiro, an AI assistant. I'm here to help you with whatever you need.";
	return "Sorry, I had trouble processing your request. Could you try again?";
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
			.map((m) => ({ role: m.role, content: m.content ?? "" }))
			.filter((m) => {
				if (m.role !== "user" && m.role !== "assistant") return false;
				const preview = getMessagePreview(m.content);
				const hasImage = Array.isArray(m.content) && m.content.some((p: ContentPart) => p.type === "image_url");
				return preview.length > 0 || hasImage;
			})
		: [];
	const hasImageInConversation = normalizedConversation.some(
		(m) => Array.isArray(m.content) && (m.content as ContentPart[]).some((p) => p.type === "image_url"),
	);
	const visionInstructions = `
## Imágenes
El usuario puede enviar imágenes. Cuando detectes una imagen:
1. Analiza la imagen con atención (código, texto, diagramas, capturas de pantalla, fotos)
2. Describe lo que ves de forma clara y concisa
3. Responde a la pregunta específica del usuario sobre la imagen
4. Si es una captura de código, proporciona el código mencionado
5. Si es un error o log, explica el problema que muestra`;
	const systemWithVision = hasImageInConversation
		? system + "\n\n" + visionInstructions
		: system;
	const fullMessages: Message[] = normalizedConversation.length > 0
		? [{ role: "system", content: systemWithVision }, ...normalizedConversation]
		: [{ role: "system", content: system }, ...messages];
	const toolsDef = getToolsDefinitionScoped(allowedTools);
	const retryPolicy = createRetryPolicy({ maxRetries: 3, baseDelayMs: 500 });
	
	const adaptToolResult = async (
		name: string,
		args: Record<string, unknown>,
	): Promise<{ ok: boolean; content: string; error?: string }> => {
		logger.info(`🔧 Ejecutando herramienta: ${name}`, { args });
		let lastError: string | undefined;
		for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
			const r = await executeToolSafeScoped(name, args, allowedTools);
			if (r.ok) {
				logger.info(`✅ Tool ${name} ejecutada correctamente`);
				return { ok: true, content: r.content };
			}
			lastError = r.error;
			logger.warn(`❌ Tool ${name} falló:`, lastError);
			const retryable = isRetryableError({ retryable: true, message: r.error ?? "" });
			if (attempt < retryPolicy.maxRetries && retryable.retryable) {
				const delay = getBackoffMs(retryPolicy, attempt);
				logger.warn(`Tool ${name} falló, reintentando en ${delay}ms`, { attempt, error: lastError });
				await new Promise((resolve) => setTimeout(resolve, delay));
			} else {
				break;
			}
		}
		return { ok: false, content: "", error: lastError };
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
			logger.info(`📋 Ejecutando paso ${i + 1}/${steps.length}: ${stepGoal}`);
			const result = await executeStep(llm, stepGoal, fullMessages, adaptToolResult, toolsDef);
			logger.info(`📋 Resultado paso ${i + 1}: ok=${result.ok}, content=${result.content?.slice(0, 100)}`);
			if (!result.ok) {
				pushEvent("error", { content: result.error }, stepId);
				logger.error(`❌ Paso falló: ${result.error}`);
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
		const verification = verifyGoal(goal, sanitized);
		if (!verification.satisfied) {
			pushEvent("error", { content: verification.reason });
		}
		return isMeaningfulResponse(sanitized) ? sanitized : FALLBACK_EMPTY_RESPONSE;
	}

	// Modo directo: conversación simple o sin planner → chat solo texto cuando effectiveTextOnly; si no, chatWithTools
	try {
		let content = "";
		for (let attempt = 0; attempt <= retryPolicy.maxRetries; attempt++) {
			try {
				content = effectiveTextOnly
					? (await llm.chat(fullMessages)).trim()
					: (await llm.chatWithTools(fullMessages, toolsDef, adaptToolResult)).trim();
				break;
			} catch (err) {
				const retryable = isRetryableError(err);
				if (attempt < retryPolicy.maxRetries && retryable.retryable) {
					const delay = getBackoffMs(retryPolicy, attempt);
					logger.warn(`LLM falló, reintentando en ${delay}ms`, { attempt, error: String(err) });
					await new Promise((resolve) => setTimeout(resolve, delay));
				} else {
					throw err;
				}
			}
		}
		const out = sanitizeModelResponse(content || "");
		pushEvent("observation", { content: out });
		return isMeaningfulResponse(out) ? out : FALLBACK_EMPTY_RESPONSE;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushEvent("error", { content: msg });
		return getFallbackResponse(goal, msg);
	}
}
