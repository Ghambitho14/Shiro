/**
 * Los chats (`/api/chat-sessions*`), el chat con el modelo (`/api/chat`, `/api/chat/stream` con SSE: comandos,
 * salas con varios agentes, herramientas) y las aprobaciones de acciones peligrosas (`/api/approvals/`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { basename, resolve as resolvePath, sep } from "node:path";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { canRememberApproval, type Approver } from "./core/tools/approval.js";
import { SCREENSHOT_DIR } from "./core/pc/pc.js";
import { setHealthActive } from "./core/health/HealthManager.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { addUsage, newUsage } from "./core/llm/LLMClient.js";
import { estimateContext, runAgent } from "./core/agent/Agent.js";
import type { ContextReport } from "./core/agent/contextUsage.js";
import { parseChatMode, parsePermissionMode, type ChatMode, type PermissionMode } from "./core/agent/chatMode.js";
import { CODE_TOOLS, getAllToolNames, HACKING_TOOLS, planToolsFor } from "./core/tools/ToolRegistry.js";
import { deleteEngagement } from "./core/pentest/engagement.js";
import { matchSkillCommand, parseCommand } from "./commands.js";
import { deleteRoom, getRoom, isValidSessionId, saveRoom } from "./core/rooms/roomStore.js";
import { currentAgents, planRoomTurn, prepareAgentTurn, publicAgent, publicRoom, type AgentTurn, type RoomPlan } from "./core/rooms/roomTurn.js";
import { attachChat, forgetChat, getProject, projectOfChat, touchProject } from "./core/projects/projects.js";
import {
	createChatSession,
	deleteChatSession,
	getChatSession,
	listChatSessions,
	renameChatSession,
	saveChatSession,
	sanitizeMessages,
	compactConversation,
	type ChatMessage,
} from "./chat/ChatStore.js";
import { closeChatSession, CloseChatError } from "./chat/closeChat.js";
import { getMessagePreview } from "./core/agent/contentUtils.js";
import { isBodyTooLargeError, readBody, safeDecode, sendJson, sendSseData } from "./http.js";

/** Aprobaciones pendientes de acciones peligrosas, resueltas desde la web. */
type PendingApproval = { finish: (approved: boolean) => void; tool: string; sessionKey: string };
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** Herramientas que el usuario permitió "siempre en este chat" (solo en memoria: se olvidan al reiniciar). */
const sessionApprovals = new Map<string, Set<string>>();
/** Salas respondiendo ahora: un turno a la vez por sala. */
const roomTurns = new Set<string>();
/** Chats resumiéndose ahora con «Cerrar conversación» (uno a la vez por chat). */
const closingChats = new Set<string>();

/** Approver para una respuesta en streaming: pregunta al navegador por SSE y espera su respuesta. */
function createSseApprover(res: ServerResponse, sessionKey: string): Approver {
	return ({ tool, summary }) =>
		new Promise<boolean>((resolve) => {
			if (res.writableEnded) return resolve(false);
			if (sessionApprovals.get(sessionKey)?.has(tool)) return resolve(true);
			const id = randomBytes(8).toString("hex");
			const finish = (approved: boolean) => {
				clearTimeout(timer);
				res.off("close", onClose);
				pendingApprovals.delete(id);
				resolve(approved);
			};
			const onClose = () => finish(false);
			const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
			res.on("close", onClose);
			pendingApprovals.set(id, { finish, tool, sessionKey });
			sendSseData(res, { type: "approval", id, tool, summary, canRemember: canRememberApproval(tool) });
		});
}

/** URL pública de una captura de pantalla (solo si está en la carpeta de capturas). */
function screenshotUrl(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const full = resolvePath(path);
	if (!full.startsWith(resolvePath(SCREENSHOT_DIR) + sep)) return undefined;
	return "/api/screenshots/" + encodeURIComponent(basename(full));
}

function sanitizeAllowedTools(input: unknown): string[] | undefined {
	if (!Array.isArray(input)) return getAllToolNames();
	const all = new Set(getAllToolNames());
	const unique: string[] = [];
	for (const item of input) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (!name || !all.has(name) || unique.includes(name)) continue;
		unique.push(name);
	}
	return unique.length > 0 ? unique : getAllToolNames();
}

/**
 * Las herramientas de una petición según el modo, los permisos y el interruptor general.
 * Elegir Code, Hacking o Planear es una decisión explícita: no depende del interruptor general de
 * herramientas. Al planear, la lista de solo lectura manda sobre cualquier ajuste.
 */
function requestTools(mode: ChatMode, permissions: PermissionMode, allowedTools: string[] | undefined, autonomous: boolean) {
	const webTools = ["search_web", "fetch_url", "get_weather"];
	const planning = permissions === "plan";
	const modeTools = planning ? planToolsFor(mode) : mode === "code" ? CODE_TOOLS : mode === "hacking" ? HACKING_TOOLS : undefined;
	const effectiveAllowedTools = modeTools ??
		(autonomous
			? allowedTools
			: (() => {
					// Cumplir “siempre internet”: en modo no-autónomo limitamos a web-tools.
					const incoming = Array.isArray(allowedTools) ? allowedTools : [];
					const filtered = incoming.filter((t) => webTools.includes(t));
					return (filtered.length ? filtered : webTools) as string[];
				})());
	return { planning, modeTools, effectiveAllowedTools };
}

export async function handleChatApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
	if (method === "POST" && pathname.startsWith("/api/approvals/")) {
		const id = pathname.slice("/api/approvals/".length);
		const pending = pendingApprovals.get(id);
		if (!pending) {
			sendJson(res, 404, { error: "Aprobación no encontrada o expirada" });
			return true;
		}
		let approved = false;
		let remember = false;
		try {
			const body = JSON.parse(await readBody(req)) as { approved?: unknown; remember?: unknown };
			approved = body.approved === true;
			remember = body.remember === true;
		} catch {
			/* cuerpo inválido = rechazar */
		}
		if (approved && remember && canRememberApproval(pending.tool)) {
			const set = sessionApprovals.get(pending.sessionKey) ?? new Set<string>();
			set.add(pending.tool);
			sessionApprovals.set(pending.sessionKey, set);
		}
		pending.finish(approved);
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (method === "GET" && pathname === "/api/chat-sessions") {
		const sessions = await listChatSessions();
		sendJson(res, 200, { sessions });
		return true;
	}

	if (method === "POST" && pathname === "/api/chat-sessions") {
		let body = "";
		try {
			body = await readBody(req);
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return true;
			}
			sendJson(res, 400, { error: "Invalid body" });
			return true;
		}
		let initialMessages: ChatMessage[] = [];
		let projectId = "";
		let chatMode: ChatMode | undefined;
		try {
			if (body.trim()) {
				const parsed = JSON.parse(body) as { messages?: unknown; projectId?: unknown; mode?: unknown };
				initialMessages = sanitizeMessages(parsed.messages);
				projectId = typeof parsed.projectId === "string" ? parsed.projectId : "";
				if (parsed.mode !== undefined) chatMode = parseChatMode(parsed.mode);
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		if (projectId && !getProject(projectId)) {
			sendJson(res, 404, { error: "No encontré el proyecto." });
			return true;
		}
		const session = await createChatSession(initialMessages, chatMode);
		// Chat nuevo dentro de un proyecto (desde la página del proyecto).
		if (projectId) attachChat(projectId, session.id);
		sendJson(res, 201, { session });
		return true;
	}

	// «Cerrar conversación»: resumen → recuerdo → mensaje `summary` del chat (closeChat.ts).
	const closeMatch = method === "POST" ? /^\/api\/chat-sessions\/([^/]+)\/close$/.exec(pathname) : null;
	if (closeMatch) {
		const id = safeDecode(closeMatch[1]).trim();
		if (id && closingChats.has(id)) {
			sendJson(res, 409, { error: "Ya lo estoy resumiendo." });
			return true;
		}
		closingChats.add(id);
		try {
			const session = await closeChatSession(id);
			if (!session) sendJson(res, 404, { error: "No encontré ese chat." });
			else sendJson(res, 200, { session });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, err instanceof CloseChatError ? 400 : 502, { error: message });
		} finally {
			closingChats.delete(id);
		}
		return true;
	}

	if (pathname.startsWith("/api/chat-sessions/")) {
		const sessionId = safeDecode(pathname.slice("/api/chat-sessions/".length)).trim();
		if (!sessionId) {
			sendJson(res, 400, { error: "session id required" });
			return true;
		}

		if (method === "GET") {
			const session = await getChatSession(sessionId);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return true;
			}
			sendJson(res, 200, { session });
			return true;
		}

		if (method === "PATCH") {
			let body = "";
			try {
				body = await readBody(req);
			} catch (err) {
				if (isBodyTooLargeError(err)) {
					sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
					return true;
				}
				sendJson(res, 400, { error: "Invalid body" });
				return true;
			}
			let title: string | undefined;
			try {
				if (body.trim()) {
					const parsed = JSON.parse(body) as { title?: unknown };
					title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;
				}
			} catch {
				sendJson(res, 400, { error: "Invalid JSON" });
				return true;
			}
			if (!title) {
				sendJson(res, 400, { error: "title required" });
				return true;
			}
			const session = await renameChatSession(sessionId, title);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return true;
			}
			sendJson(res, 200, { session });
			return true;
		}

		if (method === "PUT") {
			let body = "";
			try {
				body = await readBody(req);
			} catch (err) {
				if (isBodyTooLargeError(err)) {
					sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
					return true;
				}
				sendJson(res, 400, { error: "Invalid body" });
				return true;
			}
			let messages: ChatMessage[] = [];
			try {
				const parsed = JSON.parse(body) as { messages?: unknown };
				messages = sanitizeMessages(parsed.messages);
			} catch {
				sendJson(res, 400, { error: "Invalid JSON" });
				return true;
			}
			const session = await saveChatSession(sessionId, messages);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return true;
			}
			sendJson(res, 200, { session });
			return true;
		}

		if (method === "DELETE") {
			const ok = await deleteChatSession(sessionId);
			if (!ok) {
				sendJson(res, 404, { error: "Session not found" });
				return true;
			}
			sessionApprovals.delete(sessionId);
			forgetChat(sessionId);
			deleteRoom(sessionId);
			deleteEngagement(sessionId);
			sendJson(res, 200, { ok: true });
			return true;
		}
	}

	// Medidor de contexto antes de enviar (chat nuevo o sin medir): lo que armaría una respuesta,
	// sin llamar al modelo. En una sala se calcula como si respondiera el asistente principal.
	if (method === "POST" && pathname === "/api/chat/context") {
		let parsed: { messages?: unknown; allowedTools?: unknown; sessionId?: unknown; mode?: unknown; permissions?: unknown };
		try {
			parsed = JSON.parse(await readBody(req));
		} catch (err) {
			sendJson(res, isBodyTooLargeError(err) ? 413 : 400, { error: isBodyTooLargeError(err) ? "Request body too large (max 6 MB)" : "Invalid JSON" });
			return true;
		}
		const mode = parseChatMode(parsed.mode);
		const permissions = parsed.mode === "plan" ? "plan" : parsePermissionMode(parsed.permissions);
		const { summary: chatSummary, messages: incoming } = compactConversation(sanitizeMessages(parsed.messages));
		const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined;
		const autonomous = getConfig().autonomousMode === true;
		const { planning, effectiveAllowedTools } = requestTools(mode, permissions, sanitizeAllowedTools(parsed.allowedTools), autonomous);
		const lastUser = [...incoming].reverse().find((m) => m.role === "user");
		try {
			const context = await estimateContext(
				lastUser ? getMessagePreview(lastUser.content) : "",
				{
					llm: getLLM(),
					agentName: getState().name,
					tokenBudget: 8000,
					textOnly: false,
					allowedTools: effectiveAllowedTools,
					mode,
					permissions,
					conversation: incoming,
					chatSummary,
					userProfile: getUserProfile(),
					mcp: mode === "chat" && !planning ? autonomous : false,
					sessionId,
					projectId: projectOfChat(sessionId)?.id,
				},
				buildWorkspaceContext({ includeLongTermMemory: true }) || undefined,
			);
			sendJson(res, 200, { context });
		} catch (err) {
			sendJson(res, 200, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	if (method === "POST" && (pathname === "/api/chat" || pathname === "/api/chat/stream")) {
		let body: string;
		try {
			body = await readBody(req);
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return true;
			}
			sendJson(res, 400, { error: "Invalid body" });
			return true;
		}
		let incoming: ChatMessage[];
		let chatSummary: string | undefined;
		let allowedTools: string[] | undefined;
		let sessionId: string | undefined;
		let voice = false;
		let mode: ChatMode = "chat";
		let permissions: PermissionMode = "ask";
		let moreReasoning = false;
		try {
			const parsed = JSON.parse(body) as {
				messages?: Array<{ role?: string; content?: string }>;
				allowedTools?: unknown;
				sessionId?: unknown;
				voice?: unknown;
				mode?: unknown;
				permissions?: unknown;
				reasoning?: unknown;
			};
			voice = parsed.voice === true;
			// El modo decide las tools en el servidor; un valor desconocido vuelve a Chat.
			mode = parseChatMode(parsed.mode);
			// Una pestaña abierta de antes aún manda mode "plan": debe seguir siendo solo lectura.
			permissions = parsed.mode === "plan" ? "plan" : parsePermissionMode(parsed.permissions);
			moreReasoning = parsed.reasoning === "more";
			// Chat cerrado con «Cerrar conversación»: al modelo le llegan el resumen y lo de después.
			({ summary: chatSummary, messages: incoming } = compactConversation(sanitizeMessages(parsed.messages)));
			allowedTools = sanitizeAllowedTools(parsed.allowedTools);
			console.log("🛠️ Tools sanitized:", allowedTools?.length || "todas");
			sessionId = typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined;
			if (!incoming.length) {
				sendJson(res, 400, { error: "messages array required" });
				return true;
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		const state = getState();
		const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
		const lastMessage = incoming[incoming.length - 1];
		const userContent = getMessagePreview(lastMessage?.content ?? "");
		const hasContent = userContent.length > 0 || (Array.isArray(lastMessage?.content) && lastMessage.content.some((p: { type: string }) => p.type === "image_url"));
		if (!hasContent) {
			sendJson(res, 400, { error: "Empty message" });
			return true;
		}
		const streamSse = pathname === "/api/chat/stream";
		let lockedRoom: string | undefined;
		try {
			setHealthActive();
			const config = getConfig();
			const autonomous = config.autonomousMode === true;
			const { planning, modeTools, effectiveAllowedTools } = requestTools(mode, permissions, allowedTools, autonomous);
			const thinking = moreReasoning ? ("high" as const) : undefined;
			const goal = userContent.trim() || "¿Qué hay en esta imagen?";
			// Si el chat es de un proyecto, Shiro usa sus instrucciones y sus archivos.
			const project = projectOfChat(sessionId);
			if (project) touchProject(project.id);
			
			// Procesar comandos
			const commandResult = parseCommand(goal, sessionId ?? "web-default");
			// "/nombre-de-habilidad …": el modelo responde siguiendo esa habilidad.
			const skill = matchSkillCommand(goal)?.skill;
			if (commandResult?.executed) {
				console.log(`📝 Comando /${goal.slice(1).split(/\s/)[0]} ejecutado`);
				if (streamSse) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
					});
					sendSseData(res, { type: "done", content: commandResult.content });
					res.end();
				} else {
					sendJson(res, 200, { content: commandResult.content });
				}
				return true;
			}
			
			// Salas con varios agentes: órdenes ("activa Viernes", "agrega a Lunes"…) y quién responde.
			const agents = currentAgents();
			const roomId = sessionId && isValidSessionId(sessionId) ? sessionId : undefined;
			let roomPlan: RoomPlan | null = null;
			if (roomId && !commandResult) {
				roomPlan = planRoomTurn(goal, { sessionId: roomId, room: getRoom(roomId, agents), agents, assistantName: state.name });
			}
			if (roomPlan && roomId) {
				if (roomTurns.has(roomId)) {
					sendJson(res, 409, { error: "Espera a que termine la respuesta anterior." });
					return true;
				}
				roomTurns.add(roomId);
				lockedRoom = roomId;
				if (roomPlan.changed) {
					if (roomPlan.room) saveRoom(roomPlan.room);
					else deleteRoom(roomId);
				}
			}
			const roomPayload = roomPlan ? { room: publicRoom(roomPlan.room, agents), openVoice: roomPlan.openVoice === true } : null;
			// Orden de sala sin modelo: respuesta fija a nombre del agente (o del asistente).
			if (roomPlan?.reply) {
				const agent = roomPlan.reply.agent ? publicAgent(roomPlan.reply.agent) : null;
				if (streamSse) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
					});
					sendSseData(res, { type: "room", ...roomPayload });
					sendSseData(res, { type: "done", content: roomPlan.reply.text, agent });
					res.end();
				} else {
					sendJson(res, 200, { content: roomPlan.reply.text, agent, ...roomPayload });
				}
				return true;
			}
			let turn: AgentTurn | undefined;
			const speaker = roomPlan?.responder;
			if (speaker && roomPlan?.room) {
				turn = prepareAgentTurn(speaker, {
					room: roomPlan.room,
					agents,
					messages: incoming,
					assistantName: state.name,
					baseTools: effectiveAllowedTools,
					autonomous: mode === "chat" && !planning && autonomous,
				});
			}
			// Un agente con una lista propia nunca puede recuperar herramientas que el modo quitó.
			// En Chat se conserva su comportamiento; en Code, Hacking o al planear se cruza con la del modo.
			const responseTools =
				turn && modeTools && effectiveAllowedTools
					? (turn.allowedTools ?? effectiveAllowedTools).filter((t) => effectiveAllowedTools.includes(t))
					: turn
						? turn.allowedTools
						: effectiveAllowedTools;
			const speakerInfo = speaker ? { agent: publicAgent(speaker) } : {};

			console.log(
				"🛠️ Tools:",
				(effectiveAllowedTools as string[] | undefined)?.length || "todas (15)",
				"| Autonomous:",
				autonomous,
				"| Msg:",
				goal.slice(0, 30),
			);
			if (streamSse) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				});
				sendSseData(res, { type: "start" });
				if (roomPayload?.room && roomPlan?.changed) sendSseData(res, { type: "room", ...roomPayload });
				if (speaker) sendSseData(res, { type: "agent", agent: publicAgent(speaker) });
				// Si el navegador corta la conexión (botón "Detener"), se cancela el modelo y las tools pendientes.
				const abort = new AbortController();
				res.on("close", () => {
					if (!res.writableEnded) abort.abort();
				});
				const usage = newUsage();
				let context: ContextReport | undefined;
				try {
					const content = await runAgent(goal, {
						llm: turn?.llm ?? getLLM(),
						agentName: turn?.agentName ?? state.name,
						tokenBudget: 8000,
						textOnly: false,
						allowedTools: responseTools,
						mode,
						permissions,
						thinking,
						explainMode: config.explainMode,
						conversation: turn?.conversation ?? incoming,
						chatSummary,
						persona: turn?.persona,
						room: turn?.room,
						userProfile: getUserProfile(),
						onStreamDelta: (chunk) => sendSseData(res, { type: "delta", text: chunk }),
						onUsage: (u) => addUsage(usage, u),
						onContext: (r) => {
							context = r;
						},
						onToolEvent: (e) =>
							sendSseData(res, e.phase === "end" ? { type: "tool", ...e, image: screenshotUrl(e.image) } : { type: "tool", ...e }),
						onTodo: (items) => sendSseData(res, { type: "todo", items }),
						approver: createSseApprover(res, sessionId ?? "web-default"),
						signal: abort.signal,
						voice,
						mcp: mode === "chat" && !planning ? (turn ? turn.mcp : autonomous) : false,
						skill,
						sessionId,
						projectId: project?.id,
					}, workspaceContext ?? undefined);
					if (abort.signal.aborted) return true;
					sendSseData(res, { type: "done", content, ...speakerInfo, ...(usage.turns ? { usage } : {}), ...(context ? { context } : {}) });
					res.end();
				} catch (errIn) {
					const msgIn = errIn instanceof Error ? errIn.message : String(errIn);
					sendSseData(res, { type: "error", message: msgIn });
					res.end();
				}
				return true;
			}
			const usage = newUsage();
			let context: ContextReport | undefined;
			const content = await runAgent(goal, {
				onUsage: (u) => addUsage(usage, u),
				onContext: (r) => {
					context = r;
				},
				llm: turn?.llm ?? getLLM(),
				agentName: turn?.agentName ?? state.name,
				tokenBudget: 8000,
				textOnly: false,
				allowedTools: responseTools,
				mode,
				// Sin streaming no hay a quién preguntar: Automático y Omitir no aplican.
				permissions: planning ? "plan" : "ask",
				thinking,
				explainMode: config.explainMode,
				conversation: turn?.conversation ?? incoming,
						chatSummary,
				persona: turn?.persona,
				room: turn?.room,
				userProfile: getUserProfile(),
				sessionId,
				projectId: project?.id,
			}, workspaceContext ?? undefined);
			sendJson(res, 200, { content, ...speakerInfo, ...(roomPayload ?? {}), ...(usage.turns ? { usage } : {}), ...(context ? { context } : {}) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (streamSse && res.headersSent) {
				sendSseData(res, { type: "error", message });
				res.end();
			} else {
				sendJson(res, 502, { error: message });
			}
		} finally {
			if (lockedRoom) roomTurns.delete(lockedRoom);
		}
		return true;
	}
	return false;
}
