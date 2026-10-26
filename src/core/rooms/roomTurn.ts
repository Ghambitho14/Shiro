/**
 * Lo que comparten la web y la terminal para las salas: decidir qué hace un mensaje
 * (orden de sala, turno de un agente o nada que ver) y preparar el turno del agente.
 */
import { getConfig } from "../../config/config.js";
import { loadAgents, type AgentProfile } from "../agents/registry.js";
import type { PersonaContext, RoomContext } from "../agent/ContextBuilder.js";
import type { LLMClient } from "../llm/LLMClient.js";
import { getLLMFor, profileModelRef } from "../llm/getLLM.js";
import { resolveLLMSettings } from "../llm/providers.js";
import { buildRoomHistory, type ConversationMessage, type RoomMessage } from "./roomHistory.js";
import { detectRoomIntent } from "./roomIntent.js";
import { applyRoomIntent } from "./roomLogic.js";
import type { RoomState } from "./roomStore.js";

/** Lo que la interfaz necesita de un agente (nunca claves ni instrucciones). */
export type PublicAgent = { id: string; name: string; color?: string; mode: "text" | "voice"; voice: AgentProfile["voice"] };

export function publicAgent(a: AgentProfile): PublicAgent {
	return { id: a.id, name: a.name, color: a.color, mode: a.mode, voice: a.voice };
}

export function publicRoom(room: RoomState | null, agents: AgentProfile[]) {
	if (!room) return null;
	return {
		sessionId: room.sessionId,
		principal: room.principal,
		participants: room.participants
			.map((p) => agents.find((a) => a.id === p.agentId))
			.filter((a): a is AgentProfile => Boolean(a))
			.map((a) => ({ ...publicAgent(a), principal: a.id === room.principal })),
	};
}

export type RoomPlan = {
	room: RoomState | null;
	/** Hay que guardar (o borrar, si room es null) la sala. */
	changed: boolean;
	/** Respuesta fija de una orden (sin modelo). null en `agent` = el asistente de siempre. */
	reply?: { agent: AgentProfile | null; text: string };
	/** El agente que responde este mensaje con su modelo. */
	responder?: AgentProfile;
	openVoice?: boolean;
};

/** Palabras que se quitan del principio de una orden: la de activación y el nombre del asistente. */
export function wakeWords(assistantName: string): string[] {
	return [getConfig().wakeWord, assistantName];
}

/**
 * Qué hace este mensaje con las salas. null = nada que ver (chat normal, sin sala):
 * sigue el asistente de siempre como hasta ahora.
 */
export function planRoomTurn(
	goal: string,
	opts: { sessionId: string; room: RoomState | null; agents: AgentProfile[]; assistantName: string },
): RoomPlan | null {
	const { room, agents } = opts;
	if (!agents.length) return null;
	const intent = detectRoomIntent(goal, { agents, room, wakeWords: wakeWords(opts.assistantName) });
	if (!intent) return null;
	const out = applyRoomIntent(room, intent, { agents, sessionId: opts.sessionId, defaultName: opts.assistantName });
	const find = (id: string) => agents.find((a) => a.id === id);
	const responder = out.runTurn ? find(out.runTurn.agentId) : undefined;
	// Con una petición ("activa Viernes y dime el clima") responde el agente; el saludo sobra.
	const reply = !responder && out.reply ? { agent: out.reply.agentId ? (find(out.reply.agentId) ?? null) : null, text: out.reply.text } : undefined;
	if (!reply && !responder && !out.changed) return null;
	return { room: out.room, changed: out.changed, reply, responder, openVoice: out.openVoice };
}

export type AgentTurn = {
	llm: LLMClient;
	agentName: string;
	persona?: PersonaContext;
	room: RoomContext;
	conversation: ConversationMessage[];
	/** undefined = las mismas que el asistente; [] = solo texto. */
	allowedTools: string[] | undefined;
	mcp: boolean;
};

/**
 * Prepara el turno de un agente: su modelo, su forma de ser, sus herramientas y el historial
 * de la sala con quién dijo qué.
 */
export function prepareAgentTurn(
	profile: AgentProfile,
	opts: {
		room: RoomState;
		agents: AgentProfile[];
		messages: RoomMessage[];
		assistantName: string;
		/** Las herramientas que tendría el asistente en este mensaje (lo que permite Ajustes). */
		baseTools: string[] | undefined;
		autonomous: boolean;
	},
): AgentTurn {
	const { room, agents } = opts;
	const nameOf = (id: string | undefined, m: RoomMessage) =>
		(id ? agents.find((a) => a.id === id)?.name : undefined) ?? m.agentName ?? opts.assistantName;
	// Lo que cabe del historial: la mitad del contexto del modelo (unos 4 caracteres por token).
	const contextWindow = resolveLLMSettings(profileModelRef(profile)).contextWindow;
	const { conversation, omitted } = buildRoomHistory(opts.messages, profile.id, nameOf, {
		maxMessages: 30,
		maxChars: Math.max(6000, Math.floor(contextWindow * 4 * 0.5)),
	});
	let allowedTools: string[] | undefined;
	if (profile.tools === "none") allowedTools = [];
	else if (profile.tools === "inherit") allowedTools = opts.baseTools;
	else allowedTools = opts.autonomous || !opts.baseTools ? profile.tools : profile.tools.filter((t) => opts.baseTools!.includes(t));
	return {
		llm: getLLMFor(profile),
		agentName: profile.name,
		persona: profile.persona.trim() ? { prompt: profile.persona, replace: profile.personaMode === "replace" } : undefined,
		room: {
			self: profile.name,
			participants: room.participants
				.map((p) => agents.find((a) => a.id === p.agentId))
				.filter((a): a is AgentProfile => Boolean(a))
				.map((a) => ({ name: a.name, description: a.description || undefined, principal: a.id === room.principal })),
			omitted,
		},
		conversation,
		allowedTools,
		mcp: opts.autonomous && profile.mcp,
	};
}

/** Los agentes, sin romper el chat si agents.json tiene un error (se ve en Ajustes → Agentes). */
export function currentAgents(): AgentProfile[] {
	return loadAgents().agents;
}
