/**
 * Qué pasa con la sala tras una orden (activar, sumar, despedir, cambiar de principal, cerrar).
 * Las órdenes se contestan con un texto fijo, sin llamar a ningún modelo; cada respuesta va
 * a nombre de un agente (o del asistente de siempre, `agentId: null`).
 */
import { renderGreeting, type AgentProfile } from "../agents/registry.js";
import type { RoomIntent } from "./roomIntent.js";
import { newRoom, type RoomState } from "./roomStore.js";

export type RoomOutcome = {
	room: RoomState | null;
	/** La sala cambió (hay que guardarla o borrarla). */
	changed: boolean;
	reply?: { agentId: string | null; text: string };
	/** Además, este agente responde el mensaje con su modelo ("activa Viernes y dime el clima"). */
	runTurn?: { agentId: string };
	/** El agente prefiere hablar por voz: la web abre el modo voz. */
	openVoice?: boolean;
};

export type RoomLogicContext = {
	agents: AgentProfile[];
	sessionId: string;
	/** Nombre del asistente de siempre. */
	defaultName: string;
	now?: number;
};

function listNames(names: string[]): string {
	return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

export function applyRoomIntent(room: RoomState | null, intent: RoomIntent, ctx: RoomLogicContext): RoomOutcome {
	const now = ctx.now ?? Date.now();
	const agent = (id: string) => ctx.agents.find((a) => a.id === id);
	const inRoom = (id: string) => room?.participants.some((p) => p.agentId === id) ?? false;
	const withMember = (r: RoomState, id: string): RoomState =>
		r.participants.some((p) => p.agentId === id) ? r : { ...r, participants: [...r.participants, { agentId: id, joinedAt: now }], updatedAt: now };

	switch (intent.kind) {
		case "route":
			return { room, changed: false, runTurn: { agentId: intent.agentId } };

		case "wakeOnly": {
			if (room) return { room, changed: false, reply: { agentId: room.principal, text: "Te escucho." } };
			const names = ctx.agents.map((a) => a.name);
			const text = names.length
				? `¿A quién activo? Agentes: ${listNames(names)}.`
				: "Todavía no hay agentes. Créalos en Ajustes → Agentes.";
			return { room, changed: false, reply: { agentId: null, text } };
		}

		case "activate":
		case "add": {
			const a = agent(intent.agentId);
			if (!a) return { room, changed: false };
			const rest = intent.rest ? { runTurn: { agentId: a.id } } : {};
			if (!room) {
				return {
					room: newRoom(ctx.sessionId, a.id, now),
					changed: true,
					reply: { agentId: a.id, text: renderGreeting(a) },
					openVoice: a.mode === "voice",
					...rest,
				};
			}
			if (inRoom(a.id)) {
				return intent.rest ? { room, changed: false, ...rest } : { room, changed: false, reply: { agentId: a.id, text: "Ya estoy en la sala." } };
			}
			return { room: withMember(room, a.id), changed: true, reply: { agentId: a.id, text: `Hola, soy ${a.name}. Aquí estoy.` }, ...rest };
		}

		case "dismiss": {
			if (!room || !inRoom(intent.agentId)) return { room, changed: false };
			const a = agent(intent.agentId);
			const name = a?.name ?? intent.agentId;
			const participants = room.participants.filter((p) => p.agentId !== intent.agentId);
			if (!participants.length) {
				return { room: null, changed: true, reply: { agentId: null, text: `${name} se fue. Sigo yo, ${ctx.defaultName}.` } };
			}
			if (room.principal === intent.agentId) {
				const next = participants[0].agentId;
				const nextName = agent(next)?.name ?? next;
				return {
					room: { ...room, participants, principal: next, updatedAt: now },
					changed: true,
					reply: { agentId: intent.agentId, text: `Me retiro. Ahora te atiende ${nextName}.` },
				};
			}
			return { room: { ...room, participants, updatedAt: now }, changed: true, reply: { agentId: intent.agentId, text: "¡Hasta luego!" } };
		}

		case "promote": {
			const a = agent(intent.agentId);
			if (!a) return { room, changed: false };
			if (!room) return applyRoomIntent(room, { kind: "activate", agentId: a.id }, ctx);
			if (room.principal === a.id) return { room, changed: false, reply: { agentId: a.id, text: "Ya me estoy encargando yo." } };
			return {
				room: { ...withMember(room, a.id), principal: a.id, updatedAt: now },
				changed: true,
				reply: { agentId: a.id, text: "De acuerdo, ahora me encargo yo." },
			};
		}

		case "close":
			if (!room) return { room, changed: false };
			return { room: null, changed: true, reply: { agentId: null, text: `Sala cerrada. Sigo yo, ${ctx.defaultName}.` } };
	}
}
