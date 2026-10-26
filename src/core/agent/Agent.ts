import type { Message, ContentPart, AgentEvent } from "./Types.js";
import { getMessagePreview } from "./contentUtils.js";
import { LLMError, type LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import { readFileSync } from "node:fs";
import {
	describeToolUse,
	executeToolSafeScoped,
	getAllToolNames,
	getToolsDefinitionScoped,
	LITE_TOOLS,
	PC_TOOLS,
} from "../tools/ToolRegistry.js";
import { activeModelTuning, modelSupportsVision, PROVIDER_PRESETS, type ModelRef } from "../llm/providers.js";
import type { PersonaContext, RoomContext } from "./ContextBuilder.js";
import { logger } from "../logger.js";
import { isMeaningfulResponse, FALLBACK_EMPTY_RESPONSE } from "../sanitizeResponse.js";
import { createRetryPolicy, getBackoffMs, isRetryableError } from "../health/RetryPolicy.js";
import { getDecisionLogger, type DecisionEvent } from "./DecisionLogger.js";
import { getConfig } from "../../config/config.js";
import { runWithApprover, type Approver } from "../tools/approval.js";
import { mcpManager } from "../mcp/McpManager.js";
import { getEnabledSkills, getSkillInstructions } from "../skills/SkillLoader.js";
import { getProject, inlineProjectText, projectIndex, runWithProject } from "../projects/projects.js";

export type UserProfileForAgent = {
	userName?: string;
	language?: string;
	about?: string;
	extra?: string;
};

/** Progreso de las herramientas, para mostrarlo en la interfaz mientras trabajan. */
export type ToolEvent =
	| { phase: "start"; id: string; name: string; label: string }
	| { phase: "end"; id: string; name: string; ok: boolean; error?: string; image?: string };

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
	/**
	 * Quién aprueba las acciones peligrosas (exec, escribir archivos…).
	 * Sin approver, con approvalMode "ask" esas acciones se bloquean.
	 */
	approver?: Approver;
	/** Avisa del inicio y fin de cada herramienta. */
	onToolEvent?: (e: ToolEvent) => void;
	/** Cancela la respuesta (botón "Detener" de la web). */
	signal?: AbortSignal;
	/** El usuario habla por voz: respuestas breves y sin formato. */
	voice?: boolean;
	/** Id del chat, para que el proveedor agrupe las peticiones de la misma conversación. */
	sessionId?: string;
	/** Ofrecer las herramientas de los servidores MCP (por defecto sí, si hay approver). */
	mcp?: boolean;
	/** Habilidad que el usuario pidió con "/nombre": sus instrucciones van en el system prompt. */
	skill?: string;
	/** Proyecto del chat: sus instrucciones van en el system prompt y sus archivos se leen con la tool project. */
	projectId?: string;
	/** Forma de ser del agente de una sala (se añade a las instrucciones base o las reemplaza). */
	persona?: PersonaContext;
	/** Sala con varios agentes: quién está y cómo llegan los mensajes de los demás. */
	room?: RoomContext;
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
 * Qué herramientas ve el modelo: las pedidas (o todas), recortadas a las esenciales si el
 * perfil es "lite" (por defecto con modelos locales, que se confunden con muchas tools).
 */
export function resolveTools(
	requested: string[] | undefined,
	localModel: boolean,
	canAskUser: boolean,
	includeMcp = true,
	ref?: ModelRef,
): string[] | undefined {
	let tools = requested;
	// Ajustes → Modelo: cada modelo puede tener su perfil (pocas o todas las herramientas).
	const profile = activeModelTuning(ref).toolProfile;
	const lite = profile === "lite" || (profile === "auto" && localModel);
	if (lite) {
		tools = (tools ?? LITE_TOOLS).filter((t) => LITE_TOOLS.includes(t));
	}
	// El control del PC solo se ofrece donde se puede pedir permiso al usuario (web, terminal).
	// En WhatsApp, Telegram o tareas programadas cualquiera que escriba podría abrir cosas o mirar la pantalla.
	if (!getConfig().pcControl || !canAskUser) {
		tools = (tools ?? getAllToolNames()).filter((t) => !PC_TOOLS.includes(t));
	}
	// Las de los servidores MCP las eligió el usuario (también con modelos locales), pero pueden
	// tener efectos: igual que el control del PC, solo donde se le puede pedir permiso.
	const mcp = includeMcp && canAskUser ? mcpManager.getToolNames() : [];
	if (mcp.length) tools = [...(tools ?? getAllToolNames()), ...mcp];
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
		approver,
		onToolEvent,
		signal,
		voice = false,
		sessionId,
	} = opts;

	// Los servidores MCP que aún están arrancando tienen unos segundos para ofrecer sus tools.
	if (mcpManager.isStarted()) await mcpManager.whenReady(8000);
	// El modelo de este cliente (el de un agente puede no ser el de Ajustes → Modelo).
	const llmInfo = llm.getConfig();
	const ref: ModelRef | undefined =
		llmInfo.provider in PROVIDER_PRESETS ? { provider: llmInfo.provider as ModelRef["provider"], model: llmInfo.model } : undefined;
	let effectiveTools = resolveTools(allowedTools, llmInfo.local, approver !== undefined, opts.mcp !== false, ref);
	// use_skill solo tiene sentido si hay habilidades activas.
	const skills = getEnabledSkills();
	if (!skills.length && (effectiveTools ?? getAllToolNames()).includes("use_skill")) {
		effectiveTools = (effectiveTools ?? getAllToolNames()).filter((t) => t !== "use_skill");
	}
	// La tool project solo existe dentro de un proyecto. Solo lee (escribir pide permiso),
	// así que se ofrece aunque "Usar herramientas" esté apagado.
	const project = opts.projectId ? getProject(opts.projectId) ?? undefined : undefined;
	if (project && opts.textOnly !== true) {
		if (effectiveTools && !effectiveTools.includes("project")) effectiveTools = [...effectiveTools, "project"];
	} else if ((effectiveTools ?? getAllToolNames()).includes("project")) {
		effectiveTools = (effectiveTools ?? getAllToolNames()).filter((t) => t !== "project");
	}
	// Una lista vacía significa "ninguna tool": se responde solo con texto.
	const textOnly = opts.textOnly === true || (effectiveTools !== undefined && effectiveTools.length === 0);
	const hasPcTools = !textOnly && (effectiveTools ?? getAllToolNames()).some((t) => PC_TOOLS.includes(t));
	const vision = modelSupportsVision(llmInfo.model, undefined, ref?.provider);

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

	const projectTool = !textOnly && (effectiveTools ?? getAllToolNames()).includes("project");
	const projectContext = project
		? {
				name: project.name,
				description: project.description,
				instructions: project.instructions,
				index: projectIndex(project),
				inline: await inlineProjectText(project).catch(() => null),
				hasTool: projectTool,
			}
		: undefined;

	const { system, messages } = buildContext({
		goal,
		agentName,
		shortMemory: memory,
		tokenBudget,
		workspaceContext,
		textOnly,
		userProfile: userProfile ?? undefined,
		pcControl: hasPcTools,
		vision,
		voice,
		skills: !textOnly && (effectiveTools ?? getAllToolNames()).includes("use_skill") ? skills : undefined,
		forcedSkill: opts.skill ? getSkillInstructions(opts.skill) ?? undefined : undefined,
		project: projectContext,
		persona: opts.persona,
		room: opts.room,
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
	let toolSeq = 0;

	const executeTool = async (name: string, args: Record<string, unknown>) => {
		if (signal?.aborted) return { ok: false, content: "", error: "Cancelado por el usuario." };
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

		const id = `t${++toolSeq}`;
		onToolEvent?.({ phase: "start", id, name, label: describeToolUse(name, args) });
		const r = await executeToolSafeScoped(name, args, effectiveTools);
		usedTools.push({ name, ok: r.ok, argsKeys });
		onToolEvent?.(
			r.ok ? { phase: "end", id, name, ok: true, image: r.image } : { phase: "end", id, name, ok: false, error: r.error },
		);
		if (!r.ok) {
			logger.warn(`❌ Tool ${name} falló: ${r.error}`);
			return { ok: false, content: "", error: r.error };
		}
		if (!r.image) return { ok: true, content: r.content };
		// Capturas de pantalla: el modelo solo las recibe si puede ver imágenes.
		if (!vision) {
			const alternative = name === "browser" ? "Para saber qué hay en la página usa browser con action=read." : "Para saber qué hay abierto usa pc_windows con action=list.";
			return {
				ok: true,
				content: `${r.content}
[Tu modelo no puede ver imágenes: no describas la captura (el usuario sí la ve). ${alternative}]`,
			};
		}
		try {
			const image = `data:image/jpeg;base64,${readFileSync(r.image).toString("base64")}`;
			return { ok: true, content: `${r.content}
[La imagen va adjunta a continuación.]`, image };
		} catch {
			return { ok: true, content: r.content };
		}
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
				content = await runWithProject(project, () =>
					runWithApprover(approver, () =>
						textOnly
							? llm.chat(fullMessages, { onDelta, signal, sessionId })
							: llm.chatWithTools(fullMessages, toolsDef, executeTool, { onDelta, signal, sessionId }),
					),
				);
				break;
			} catch (err) {
				if (signal?.aborted) throw err;
				const retryable = err instanceof LLMError ? err.retryable : isRetryableError(err).retryable;
				// Si ya se mostró texto en streaming, reintentar lo duplicaría.
				if (!retryable || attempt >= retryPolicy.maxRetries || usedTools.length > 0 || streamed) throw err;
				const delay = getBackoffMs(retryPolicy, attempt);
				logger.warn(`El modelo falló, reintento en ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	} catch (err) {
		// Detenido por el usuario: lo que se alcanzó a mostrar ya lo tiene la interfaz.
		if (signal?.aborted) return "";
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
