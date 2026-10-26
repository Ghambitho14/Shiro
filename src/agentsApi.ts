/**
 * API de Ajustes → Agentes (notas de Agentes/ en la memoria) y de las salas (data/rooms/):
 * los botones de la barra de participantes y "Abrir sala".
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig } from "./config/config.js";
import { createChatSession } from "./chat/ChatStore.js";
import { createAgent, deleteAgent, getAgent, loadAgents, renderGreeting, updateAgent, type ValidationContext } from "./core/agents/registry.js";
import { getLLM, getLLMFor } from "./core/llm/getLLM.js";
import { applyRoomIntent } from "./core/rooms/roomLogic.js";
import { deleteRoom, getRoom, isValidSessionId, newRoom, saveRoom } from "./core/rooms/roomStore.js";
import { publicAgent, publicRoom } from "./core/rooms/roomTurn.js";
import { getAllToolNames } from "./core/tools/ToolRegistry.js";
import { getState } from "./store.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

function validationContext(): ValidationContext {
	return { assistantName: getState().name, wakeWord: getConfig().wakeWord, knownTools: getAllToolNames() };
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Crea un chat que ya es una sala con este agente, con su saludo como primer mensaje. */
export async function openRoomChat(agentId: string) {
	const agent = getAgent(agentId);
	if (!agent) throw new Error("Ese agente no existe.");
	const session = await createChatSession([{ role: "assistant", content: renderGreeting(agent), ts: Date.now(), agent: agent.id, agentName: agent.name }]);
	const room = newRoom(session.id, agent.id);
	saveRoom(room);
	return { session, room: publicRoom(room, loadAgents().agents), agent: publicAgent(agent) };
}

export async function handleAgentsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, { readJson, sendJson }: Helpers): Promise<boolean> {
	if (pathname === "/api/agents" || pathname.startsWith("/api/agents/")) {
		try {
			if (pathname === "/api/agents" && method === "GET") {
				const { agents, error } = loadAgents();
				const llm = getLLM().getConfig();
				sendJson(res, 200, {
					agents,
					error,
					defaultAgent: { name: getState().name, provider: llm.provider, model: llm.model },
					wakeWord: getConfig().wakeWord,
					tools: getAllToolNames(),
				});
				return true;
			}
			if (pathname === "/api/agents" && method === "POST") {
				sendJson(res, 201, createAgent(await readJson(req), validationContext()));
				return true;
			}
			const [id, action] = pathname.slice("/api/agents/".length).split("/");
			if (action === "test" && method === "POST") {
				const agent = getAgent(id);
				if (!agent) {
					sendJson(res, 404, { error: "Ese agente no existe." });
					return true;
				}
				try {
					const t0 = Date.now();
					const reply = await getLLMFor(agent).chat([{ role: "user", content: "Responde solo: ok" }]);
					sendJson(res, 200, { ok: true, reply: reply.slice(0, 200), ms: Date.now() - t0, model: getLLMFor(agent).getConfig() });
				} catch (err) {
					sendJson(res, 200, { ok: false, error: errorText(err) });
				}
				return true;
			}
			if (!action && method === "PUT") {
				sendJson(res, 200, updateAgent(id, await readJson(req), validationContext()));
				return true;
			}
			if (!action && method === "DELETE") {
				if (!deleteAgent(id)) sendJson(res, 404, { error: "Ese agente no existe." });
				else sendJson(res, 200, { ok: true });
				return true;
			}
			sendJson(res, 405, { error: "Método no permitido" });
		} catch (err) {
			sendJson(res, 400, { error: errorText(err) });
		}
		return true;
	}

	if (pathname === "/api/rooms" || pathname.startsWith("/api/rooms/")) {
		try {
			if (pathname === "/api/rooms" && method === "POST") {
				const d = await readJson<{ agentId?: unknown }>(req);
				if (typeof d.agentId !== "string") throw new Error("Falta el agente.");
				sendJson(res, 201, await openRoomChat(d.agentId));
				return true;
			}
			const sessionId = decodeURIComponent(pathname.slice("/api/rooms/".length));
			if (!isValidSessionId(sessionId)) {
				sendJson(res, 400, { error: "Id de chat no válido." });
				return true;
			}
			const agents = loadAgents().agents;
			if (method === "GET") {
				sendJson(res, 200, { room: publicRoom(getRoom(sessionId, agents), agents) });
				return true;
			}
			if (method === "POST") {
				const d = await readJson<{ action?: unknown; agentId?: unknown }>(req);
				const agentId = typeof d.agentId === "string" ? d.agentId : "";
				const kinds = { add: "add", remove: "dismiss", promote: "promote", close: "close" } as const;
				const kind = kinds[String(d.action) as keyof typeof kinds];
				if (!kind || (kind !== "close" && !agents.some((a) => a.id === agentId))) throw new Error("Acción o agente no válidos.");
				const room = getRoom(sessionId, agents);
				const intent = kind === "close" ? { kind } : { kind, agentId };
				const out = applyRoomIntent(room, intent, { agents, sessionId, defaultName: getState().name });
				if (out.changed) {
					if (out.room) saveRoom(out.room);
					else deleteRoom(sessionId);
				}
				sendJson(res, 200, { room: publicRoom(out.room, agents) });
				return true;
			}
			sendJson(res, 405, { error: "Método no permitido" });
		} catch (err) {
			sendJson(res, 400, { error: errorText(err) });
		}
		return true;
	}
	return false;
}
