import type { Message, ContentPart } from "./Types.js";
import { getMessagePreview } from "./contentUtils.js";
import { LLMError, type LLMClient, type TokenUsage, type ToolDef } from "../llm/LLMClient.js";
import { buildContext } from "./ContextBuilder.js";
import { readFileSync } from "node:fs";
import {
	describeToolUse,
	executeToolSafeScoped,
	getAllToolNames,
	getToolsDefinitionScoped,
	LITE_TOOLS,
	PC_TOOLS,
	WINDOWS_ONLY_TOOLS,
} from "../tools/ToolRegistry.js";
import { activeModelTuning, modelSupportsVision, PROVIDER_PRESETS, resolveLLMSettings, saverOn, type ModelRef } from "../llm/providers.js";
import { selectToolsByIntent } from "./toolIntent.js";
import { historyBudget, trimHistory } from "./historyBudget.js";
import type { PersonaContext, RoomContext } from "./ContextBuilder.js";
import { logger } from "../logger.js";
import { isMeaningfulResponse, FALLBACK_EMPTY_RESPONSE } from "../sanitizeResponse.js";
import { createRetryPolicy, getBackoffMs, isRetryableError } from "../health/RetryPolicy.js";
import { getConfig } from "../../config/config.js";
import { runWithApprover, type Approver } from "../tools/approval.js";
import { mcpManager } from "../mcp/McpManager.js";
import { getEnabledSkills, getSkillInstructions } from "../skills/SkillLoader.js";
import { getProject, inlineProjectText, projectIndex, projectSources, runWithProject, type Project } from "../projects/projects.js";
import { measureContext, type ContextReport, type PromptSections } from "./contextUsage.js";
import { contextLimit } from "../llm/contextLimit.js";
import { normalizeToolResult, toolResultLimit } from "../llm/toolRuntime.js";
import { buildToolGuide, collectEnvironment, formatEnvironment } from "./environment.js";
import { buildPreviousWork, withSystemNote, type PreviousStep, type TodoItem } from "./previousWork.js";
import { describeFolder, formatFolderInfo } from "../projects/folderInfo.js";
import { terminal } from "../terminal/terminal.js";
import { claudeCodeLauncher } from "../claudeCode/claudeCode.js";
import { loadAgents } from "../agents/registry.js";
import { runWithAgentContext, type AgentRunContext } from "./runContext.js";
import type { ThinkingLevel } from "../../config/config.js";
import { isPlanToolCall, type ChatMode, type PermissionMode } from "./chatMode.js";

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
	/** `tools` y `todo`: lo que hizo en cada respuesta (la web lo manda), para que sepa qué miró en la anterior. */
	conversation?: Array<{ role: "user" | "assistant"; content: string | ContentPart[]; tools?: PreviousStep[]; todo?: TodoItem[] }>;
	userProfile?: UserProfileForAgent | null;
	/** Recibe el texto a medida que el modelo lo genera (streaming real). */
	onStreamDelta?: (chunk: string) => void;
	/** Tokens que gasta cada vuelta con el modelo (para mostrar cuánto costó la respuesta). */
	onUsage?: (usage: TokenUsage) => void;
	/** Al terminar: cuánto contexto del modelo ocupó la respuesta y en qué (medidor de la web). */
	onContext?: (report: ContextReport) => void;
	/**
	 * Quién aprueba las acciones peligrosas (exec, escribir archivos…).
	 * Sin approver, con approvalMode "ask" esas acciones se bloquean.
	 */
	approver?: Approver;
	/** Avisa del inicio y fin de cada herramienta. */
	onToolEvent?: (e: ToolEvent) => void;
	/** La lista de tareas cambió (tool `todo`): la web la pinta en el chat. */
	onTodo?: (items: TodoItem[]) => void;
	/** Cancela la respuesta (botón "Detener" de la web). */
	signal?: AbortSignal;
	/** El usuario habla por voz: respuestas breves y sin formato. */
	voice?: boolean;
	/** Chat normal, programación o pentesting autorizado. */
	mode?: ChatMode;
	/** Preguntar, planear (solo lectura), automático u omitir permisos. Solo la web la elige; sin approver no aplica. */
	permissions?: PermissionMode;
	/** Cuánto piensa en esta respuesta, si no es lo de Ajustes → Modelo. */
	thinking?: ThinkingLevel;
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
	/** Resumen de «Cerrar conversación» (`compactConversation`): `conversation` ya trae solo lo de después. */
	chatSummary?: string;
	/** Es un ayudante creado con `delegate`: hace su tarea y no puede crear otros. */
	subagent?: { boss: string };
};

/** Herramientas que en Code, dentro de un proyecto, se confunden con `project` (ver prepareRun). */
export const PROJECT_OVERLAP_TOOLS = ["read_file", "write_file", "list_dir", "write_file_system"];

/** Veces que se permite repetir exactamente la misma llamada (nombre + args) en una respuesta. */
const MAX_IDENTICAL_TOOL_CALLS = 2;
/** Lo que ocupa una captura en el contexto, en letras (≈800 tokens, como en historyBudget). */
const IMAGE_CHARS = 2800;

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
	mode: ChatMode = "chat",
	planning = false,
): string[] | undefined {
	let tools = requested;
	// Ajustes → Modelo: cada modelo puede tener su perfil (pocas o todas las herramientas).
	// Code, Hacking y Planear ya son listas elegidas a propósito: no se vuelven a recortar.
	const profile = activeModelTuning(ref).toolProfile;
	const lite = mode === "chat" && !planning && (profile === "lite" || (profile === "auto" && localModel));
	if (lite) {
		tools = (tools ?? LITE_TOOLS).filter((t) => LITE_TOOLS.includes(t));
	}
	// El control del PC solo se ofrece donde se puede pedir permiso al usuario (web, terminal).
	// En WhatsApp, Telegram o tareas programadas cualquiera que escriba podría abrir cosas o mirar la pantalla.
	// Code y Hacking se activan a propósito: conservan su terminal (cada comando sigue pidiendo
	// permiso), pero solo donde hay approver (canAskUser).
	const stripPc = !canAskUser || (!getConfig().pcControl && mode === "chat");
	if (stripPc) {
		tools = (tools ?? getAllToolNames()).filter((t) => !PC_TOOLS.includes(t));
	}
	// En Linux (Kali, Docker) estas fallarían siempre: mejor que el modelo no las vea.
	if (process.platform !== "win32") {
		tools = (tools ?? getAllToolNames()).filter((t) => !WINDOWS_ONLY_TOOLS.includes(t));
	}
	// Las de los servidores MCP las eligió el usuario (también con modelos locales), pero pueden
	// tener efectos: igual que el control del PC, solo donde se le puede pedir permiso. Nunca al planear.
	const mcp = !planning && includeMcp && canAskUser ? mcpManager.getToolNames() : [];
	if (mcp.length) tools = [...(tools ?? getAllToolNames()), ...mcp];
	return tools;
}

/** Lo que se mira para elegir herramientas: el mensaje nuevo, los dos anteriores del usuario y la última respuesta. */
function intentTexts(goal: string, conversation?: AgentOptions["conversation"]): string[] {
	const recent = (conversation ?? []).filter((m) => m.role === "user" || m.role === "assistant").slice(-6);
	const users = recent.filter((m) => m.role === "user").slice(-3);
	const lastAssistant = recent.filter((m) => m.role === "assistant").slice(-1);
	return [goal, ...[...users, ...lastAssistant].map((m) => getMessagePreview(m.content ?? ""))];
}

/**
 * Recorta la conversación al presupuesto del modelo. Solo se sabe cuánto contexto hay de verdad
 * con Ollama (num_ctx) y con el llama.cpp integrado ya abierto; con el resto, "automático" usa el
 * tope de la nube. `fixedChars`: instrucciones y herramientas, que van siempre.
 */
function trimToBudget(history: Message[], fixedChars: number, ref?: ModelRef): Message[] {
	const s = resolveLLMSettings(ref);
	const preset = PROVIDER_PRESETS[s.provider];
	const knownContext = s.local && (preset.dialect === "ollama" || Boolean(preset.managed));
	const budget = historyBudget({
		setting: activeModelTuning(ref).historyTokens,
		local: knownContext,
		contextWindow: s.contextWindow,
		fixedChars,
		reserveTokens: s.maxTokens ?? 1024,
	});
	const kept = trimHistory(history, budget);
	if (kept.length < history.length) logger.info(`✂️ Conversación recortada: se envían ${kept.length} de ${history.length} mensajes (≈${budget} tokens)`);
	return kept;
}

/** Todo lo que se le manda al modelo en una respuesta, ya armado (sin llamarlo todavía). */
type PreparedRun = {
	mode: ChatMode;
	permissions: PermissionMode;
	planning: boolean;
	ref: ModelRef | undefined;
	effectiveTools: string[] | undefined;
	textOnly: boolean;
	saverLimits: boolean;
	vision: boolean;
	project: Project | undefined;
	effectiveExplainMode: "off" | "brief" | "on";
	toolsDef: ToolDef[];
	fullMessages: Message[];
	/** Para el medidor de contexto: lo que ocupa cada parte de las instrucciones. */
	sections: PromptSections;
	/** La conversación que se envía (ya recortada) y cuántos mensajes tiene el chat. */
	sentMessages: Message[];
	totalMessages: number;
	/** Tamaño del contexto del modelo en tokens, si se sabe, y lo que cabe en cada resultado de herramienta. */
	contextTokens: number | undefined;
	resultChars: number;
};

async function prepareRun(goal: string, opts: AgentOptions, workspaceContext?: string): Promise<PreparedRun> {
	const { llm, agentName, tokenBudget = 8000, allowedTools, explainMode = "off", conversation, userProfile, approver, voice = false } = opts;

	const mode = opts.mode ?? "chat";
	const permissions = opts.permissions ?? "ask";
	const planning = permissions === "plan";
	// Los servidores MCP que aún están arrancando tienen unos segundos para ofrecer sus tools.
	if (mcpManager.isStarted()) await mcpManager.whenReady(8000);
	// El modelo de este cliente (el de un agente puede no ser el de Ajustes → Modelo).
	const llmInfo = llm.getConfig();
	const ref: ModelRef | undefined =
		llmInfo.provider in PROVIDER_PRESETS ? { provider: llmInfo.provider as ModelRef["provider"], model: llmInfo.model } : undefined;
	let effectiveTools = resolveTools(allowedTools, llmInfo.local, approver !== undefined, opts.mcp !== false, ref, mode, planning);
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
	// En Code con un proyecto, `project` hace todo el trabajo con archivos. Las de notas (read_file…) y la de
	// escribir en cualquier parte se le parecen demasiado: los modelos chicos las eligen por el nombre, fallan
	// o reescriben archivos enteros pidiendo permiso hasta para leer. Lo de fuera del proyecto, con la terminal.
	if (project && mode === "code" && opts.textOnly !== true) {
		effectiveTools = (effectiveTools ?? getAllToolNames()).filter((t) => !PROJECT_OVERLAP_TOOLS.includes(t));
	}
	// Claude Code solo en un proyecto con carpeta vinculada y si está instalado en este equipo.
	const canUseClaudeCode = Boolean(project?.folders.length) && claudeCodeLauncher() !== null;
	if (!canUseClaudeCode && (effectiveTools ?? getAllToolNames()).includes("claude_code")) {
		effectiveTools = (effectiveTools ?? getAllToolNames()).filter((t) => t !== "claude_code");
	}
	// Los ayudantes no crean otros ayudantes ni llevan la lista de tareas: eso es del jefe.
	if (opts.subagent && (effectiveTools ?? getAllToolNames()).some((t) => t === "delegate" || t === "todo")) {
		effectiveTools = (effectiveTools ?? getAllToolNames()).filter((t) => t !== "delegate" && t !== "todo");
	}
	// Modo ahorro: solo en Chat. Code, Hacking y Planear ya tienen listas completas para su tarea;
	// quitarles herramientas por palabras clave o limitar sus pasos los dejaría cojos a mitad de trabajo.
	const saverLimits = mode === "chat" && !planning;
	if (saverOn(ref) && opts.textOnly !== true && saverLimits) {
		const before = effectiveTools ?? getAllToolNames();
		if (before.length) {
			effectiveTools = selectToolsByIntent(before, intentTexts(goal, conversation));
			if (effectiveTools.length < before.length) logger.info(`🎯 Modo ahorro: ${effectiveTools.length} de ${before.length} herramientas`);
		}
	}
	// Una lista vacía significa "ninguna tool": se responde solo con texto.
	const textOnly = opts.textOnly === true || (effectiveTools !== undefined && effectiveTools.length === 0);
	// El bloque general de control del PC solo cuando tiene esas tools; tener terminal o Claude Code
	// no significa que pueda abrir apps, mover el ratón o cambiar el volumen.
	const generalPcTools = ["pc_open", "pc_screenshot", "pc_keyboard", "pc_mouse", "pc_media", "pc_windows"];
	const hasPcTools = !textOnly && (effectiveTools ?? getAllToolNames()).some((t) => generalPcTools.includes(t));
	const vision = modelSupportsVision(llmInfo.model, undefined, ref?.provider);

	const wantExplain = /\b(explica|explicame|explícame|que hiciste|qué hiciste|como lo hiciste|cómo lo hiciste|pasos|tools|herramientas)\b/i.test(goal || "");
	const effectiveExplainMode = wantExplain && explainMode === "off" ? "brief" : explainMode;

	const toolNames = textOnly ? [] : (effectiveTools ?? getAllToolNames());
	const projectTool = toolNames.includes("project");
	// Dónde está la terminal: solo si el modelo la tiene (abrirla no hace falta para saberlo).
	const shell = toolNames.includes("terminal") ? terminal.shellInfo() : undefined;
	const projectContext = project
		? {
				name: project.name,
				description: project.description,
				instructions: project.instructions,
				index: projectIndex(project),
				inline: await inlineProjectText(project).catch(() => null),
				hasTool: projectTool,
				folders: projectSources(project)
					.filter((s) => s.kind === "folder")
					.map((s) => ({ path: s.root, note: formatFolderInfo(describeFolder(s.root), s.label) || undefined })),
				terminalCwd: shell?.cwd,
			}
		: undefined;

	// El contexto del modelo decide cuánto cabe en cada resultado de herramienta.
	const contextTokens = await limitFor(ref);
	const resultChars = toolResultLimit(ref, saverLimits && saverOn(ref), contextTokens);
	// Entorno y guía de herramientas: solo donde hay a quién pedir permiso (web y terminal). Por WhatsApp o
	// Telegram escribe cualquiera: no se le cuenta cómo es el equipo.
	const trusted = approver !== undefined && !textOnly;
	const environment = trusted
		? formatEnvironment(collectEnvironment({ hacking: mode === "hacking", shell }), {
				mode,
				permissions,
				tools: toolNames,
				contextLimit: contextTokens,
				approvalMode: getConfig().approvalMode,
			})
		: undefined;
	const toolGuide = trusted ? buildToolGuide(toolNames, { mode, planning, pcBlock: hasPcTools, pcControlOff: !getConfig().pcControl }) || undefined : undefined;

	const { system, messages, sections } = buildContext({
		goal,
		agentName,
		tokenBudget,
		workspaceContext,
		textOnly,
		userProfile: userProfile ?? undefined,
		pcControl: hasPcTools,
		vision,
		voice,
		mode,
		planning,
		skills: !textOnly && (effectiveTools ?? getAllToolNames()).includes("use_skill") ? skills : undefined,
		forcedSkill: opts.skill ? getSkillInstructions(opts.skill) ?? undefined : undefined,
		project: projectContext,
		persona: opts.persona,
		room: opts.room,
		chatSummary: opts.chatSummary,
		subagent: opts.subagent,
		// El jefe sabe a qué agentes de Ajustes → Agentes puede encargar tareas.
		helpers:
			!textOnly && (effectiveTools ?? getAllToolNames()).includes("delegate")
				? loadAgents().agents.map((a) => ({ name: a.name, description: a.description || undefined }))
				: undefined,
		environment,
		toolGuide,
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

	const toolsDef = getToolsDefinitionScoped(effectiveTools);
	// Solo se manda la parte del chat que cabe en el presupuesto (Ajustes → Modelo → "Conversación
	// que se envía"): cada vuelta con herramientas reenvía todo, y un chat largo gasta muchísimo.
	const sentHistory = history.length ? trimToBudget(history, system.length + JSON.stringify(toolsDef ?? []).length, ref) : history;
	// Qué hizo en su respuesta anterior va pegado al mensaje nuevo, que es donde el modelo mira (arriba, en las
	// instrucciones, los modelos chicos no lo ven). Un ayudante empieza de cero: lo anterior es de su jefe.
	const previous = opts.subagent || textOnly ? undefined : buildPreviousWork(conversation);
	const sentMessages = withSystemNote(sentHistory.length ? sentHistory : messages, previous);
	const fullMessages: Message[] = [{ role: "system", content: system }, ...sentMessages];

	return {
		mode,
		permissions,
		planning,
		ref,
		effectiveTools,
		textOnly,
		saverLimits,
		vision,
		project,
		effectiveExplainMode,
		toolsDef,
		fullMessages,
		sections,
		sentMessages,
		totalMessages: history.length || sentMessages.length,
		contextTokens,
		resultChars,
	};
}

/** Tamaño del contexto del modelo de esta respuesta (el de un agente o el de Ajustes), si se sabe. */
function limitFor(ref: ModelRef | undefined): Promise<number | undefined> {
	return contextLimit(resolveLLMSettings(ref)).catch(() => undefined);
}

/**
 * El medidor de contexto antes de enviar: arma lo mismo que una respuesta, sin llamar al modelo.
 * Se calcula como en la web (que siempre puede preguntar), aunque aquí no haya a quién.
 */
export async function estimateContext(goal: string, opts: AgentOptions, workspaceContext?: string): Promise<ContextReport> {
	const prep = await prepareRun(goal, { ...opts, approver: opts.approver ?? (async () => false) }, workspaceContext);
	const empty = !opts.conversation?.length;
	return measureContext({
		sections: prep.sections,
		history: empty ? [] : prep.sentMessages,
		totalMessages: empty ? 0 : prep.totalMessages,
		tools: prep.toolsDef,
		limit: await limitFor(prep.ref),
		preview: true,
	});
}

export async function runAgent(goal: string, opts: AgentOptions, workspaceContext?: string): Promise<string> {
	const { llm, agentName, onStreamDelta, onUsage, approver, onToolEvent, signal, userProfile, sessionId } = opts;
	const prep = await prepareRun(goal, opts, workspaceContext);
	const { mode, permissions, planning, ref, effectiveTools, textOnly, saverLimits, vision, project, effectiveExplainMode, toolsDef, fullMessages } = prep;

	// Medidor de contexto: lo que leyó el modelo en la última vuelta y lo que trajeron las herramientas.
	let lastInput: number | undefined;
	let toolResultChars = 0;
	const trackUsage = (u: TokenUsage) => {
		if (u.input > 0) lastInput = u.input;
		onUsage?.(u);
	};
	const reportContext = async () => {
		if (!opts.onContext) return;
		opts.onContext(
			measureContext({
				sections: prep.sections,
				history: prep.sentMessages,
				totalMessages: prep.totalMessages,
				tools: toolsDef,
				toolResultChars,
				realInput: lastInput,
				limit: prep.contextTokens ?? (await limitFor(ref)),
			}),
		);
	};

	const usedTools: { name: string; ok: boolean; argsKeys: string[] }[] = [];
	const callCounts = new Map<string, number>();
	let toolSeq = 0;

	const runTool = async (name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content: string; error?: string; image?: string }> => {
		if (signal?.aborted) return { ok: false, content: "", error: "Cancelado por el usuario." };
		const argsKeys = Object.keys(args ?? {}).slice(0, 12);
		logger.info(`🔧 Tool: ${name}`);

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
		// Planear es solo lectura de verdad: project agrupa leer y escribir bajo un mismo nombre,
		// así que la acción se vuelve a comprobar aquí, también para los ayudantes de delegate.
		const r =
			planning && !isPlanToolCall(name, args)
				? { ok: false as const, error: "Estás planeando: es solo lectura. Para modificar archivos o ejecutar acciones, el usuario tiene que cambiar el botón de permisos del chat a Preguntar o Automático." }
				: await executeToolSafeScoped(name, args, effectiveTools);
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
	const executeTool = async (name: string, args: Record<string, unknown>) => {
		const out = await runTool(name, args);
		if (opts.onContext) {
			// Como lo recibe el modelo (client.ts lo recorta igual), más la llamada y una captura si la hay.
			const raw = out.ok ? out.content : `Error: ${out.error ?? "desconocido"}`;
			const given = name === "use_skill" ? raw : normalizeToolResult(raw, ref, saverLimits && saverOn(ref), prep.resultChars);
			toolResultChars += given.length + JSON.stringify(args ?? {}).length + name.length + 60 + (out.image ? IMAGE_CHARS : 0);
		}
		return out;
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
	// Para las tools que necesitan saber de esta respuesta (delegate crea ayudantes con lo mismo).
	const runContext: AgentRunContext = {
		llm,
		agentName,
		mode,
		permissions,
		thinking: opts.thinking,
		tools: effectiveTools,
		approver,
		signal,
		userProfile,
		workspaceContext,
		sessionId,
		projectId: project?.id,
		subagent: opts.subagent !== undefined,
		launched: 0,
		resultChars: prep.resultChars,
		onTodo: opts.onTodo,
	};
	let content = "";
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				content = await runWithAgentContext(runContext, () =>
					runWithProject(project, () =>
						runWithApprover(
							approver,
							() =>
								textOnly
									? llm.chat(fullMessages, { onDelta, onUsage: trackUsage, signal, sessionId, thinking: opts.thinking })
									: llm.chatWithTools(fullMessages, toolsDef, executeTool, {
										onDelta,
										onUsage: trackUsage,
										signal,
										sessionId,
										thinking: opts.thinking,
										saverLimits,
										resultChars: prep.resultChars,
										contextTokens: prep.contextTokens,
									}),
							permissions,
						),
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
		// Si no cupo, el medidor lo muestra lleno (con lo estimado: el modelo no dijo cuánto leyó).
		await reportContext();
		return describeFailure(err);
	}

	await reportContext();
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
