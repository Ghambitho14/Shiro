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
import { runAgent } from "./core/agent/Agent.js";
import { getAllToolNames } from "./core/tools/ToolRegistry.js";
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
	type ChatMessage,
} from "./chat/ChatStore.js";
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
		try {
			if (body.trim()) {
				const parsed = JSON.parse(body) as { messages?: unknown; projectId?: unknown };
				initialMessages = sanitizeMessages(parsed.messages);
				projectId = typeof parsed.projectId === "string" ? parsed.projectId : "";
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		if (projectId && !getProject(projectId)) {
			sendJson(res, 404, { error: "No encontré el proyecto." });
			return true;
		}
		const session = await createChatSession(initialMessages);
		// Chat nuevo dentro de un proyecto (desde la página del proyecto).
		if (projectId) attachChat(projectId, session.id);
		sendJson(res, 201, { session });
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
			sendJson(res, 200, { ok: true });
			return true;
		}
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
		let allowedTools: string[] | undefined;
		let sessionId: string | undefined;
		let voice = false;
		try {
			const parsed = JSON.parse(body) as {
				messages?: Array<{ role?: string; content?: string }>;
				allowedTools?: unknown;
				sessionId?: unknown;
				voice?: unknown;
			};
			voice = parsed.voice === true;
			incoming = sanitizeMessages(parsed.messages);
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
				const webTools = ["search_web", "fetch_url", "get_weather"];
				const effectiveAllowedTools =
					autonomous
						? allowedTools
						: (() => {
								// Cumplir “siempre internet”: en modo no-autónomo limitamos a web-tools.
								const incoming = Array.isArray(allowedTools) ? allowedTools : [];
								const filtered = incoming.filter((t) => webTools.includes(t));
								return (filtered.length ? filtered : webTools) as string[];
							})();
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
					autonomous,
				});
			}
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
				try {
					const content = await runAgent(goal, {
						llm: turn?.llm ?? getLLM(),
						agentName: turn?.agentName ?? state.name,
						tokenBudget: 8000,
						textOnly: false,
						allowedTools: turn ? turn.allowedTools : effectiveAllowedTools,
						explainMode: config.explainMode,
						conversation: turn?.conversation ?? incoming,
						persona: turn?.persona,
						room: turn?.room,
						userProfile: getUserProfile(),
						onStreamDelta: (chunk) => sendSseData(res, { type: "delta", text: chunk }),
						onToolEvent: (e) =>
							sendSseData(res, e.phase === "end" ? { type: "tool", ...e, image: screenshotUrl(e.image) } : { type: "tool", ...e }),
						approver: createSseApprover(res, sessionId ?? "web-default"),
						signal: abort.signal,
						voice,
						mcp: turn ? turn.mcp : autonomous,
						skill,
						sessionId,
						projectId: project?.id,
					}, workspaceContext ?? undefined);
					if (abort.signal.aborted) return true;
					sendSseData(res, { type: "done", content, ...speakerInfo });
					res.end();
				} catch (errIn) {
					const msgIn = errIn instanceof Error ? errIn.message : String(errIn);
					sendSseData(res, { type: "error", message: msgIn });
					res.end();
				}
				return true;
			}
			const content = await runAgent(goal, {
				llm: turn?.llm ?? getLLM(),
				agentName: turn?.agentName ?? state.name,
				tokenBudget: 8000,
				textOnly: false,
				allowedTools: turn ? turn.allowedTools : effectiveAllowedTools,
				explainMode: config.explainMode,
				conversation: turn?.conversation ?? incoming,
				persona: turn?.persona,
				room: turn?.room,
				userProfile: getUserProfile(),
				sessionId,
				projectId: project?.id,
			}, workspaceContext ?? undefined);
			sendJson(res, 200, { content, ...speakerInfo, ...(roomPayload ?? {}) });
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
