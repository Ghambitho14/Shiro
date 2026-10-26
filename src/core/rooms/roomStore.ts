/**
 * Salas: un chat con varios agentes (data/rooms/<id del chat>.json).
 * Siempre en este equipo, como los proyectos: así no hay que tocar cómo se guardan los chats
 * (este equipo, Obsidian o Supabase). Los mensajes llevan `agent` para saber quién habló.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import type { AgentProfile } from "../agents/registry.js";

export const ROOMS_DIR = join(DATA_DIR, "rooms");
const SESSION_RE = /^[\w-]{1,80}$/;

export type RoomParticipant = { agentId: string; joinedAt: number };

export type RoomState = {
	version: 1;
	sessionId: string;
	/** Agente que responde si no se nombra a otro. */
	principal: string;
	/** En el orden en que entraron. */
	participants: RoomParticipant[];
	createdAt: number;
	updatedAt: number;
};

export function isValidSessionId(id: string): boolean {
	return SESSION_RE.test(id);
}

function roomFile(sessionId: string): string {
	if (!isValidSessionId(sessionId)) throw new Error("Id de chat no válido.");
	return join(ROOMS_DIR, `${sessionId}.json`);
}

export function newRoom(sessionId: string, agentId: string, now = Date.now()): RoomState {
	return { version: 1, sessionId, principal: agentId, participants: [{ agentId, joinedAt: now }], createdAt: now, updatedAt: now };
}

/**
 * Quita a los agentes que ya no existen y, si el principal se fue, elige al siguiente que entró.
 * Devuelve null si no queda nadie.
 */
export function pruneRoom(room: RoomState, agents: Pick<AgentProfile, "id">[]): RoomState | null {
	const ids = new Set(agents.map((a) => a.id));
	const seen = new Set<string>();
	const participants = room.participants.filter((p) => ids.has(p.agentId) && !seen.has(p.agentId) && seen.add(p.agentId));
	if (!participants.length) return null;
	const principal = participants.some((p) => p.agentId === room.principal) ? room.principal : participants[0].agentId;
	return { ...room, participants, principal };
}

function parseRoom(raw: unknown, sessionId: string): RoomState | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (!Array.isArray(r.participants) || typeof r.principal !== "string") return null;
	const participants = r.participants
		.filter((p): p is RoomParticipant => !!p && typeof p === "object" && typeof (p as RoomParticipant).agentId === "string")
		.map((p) => ({ agentId: p.agentId, joinedAt: typeof p.joinedAt === "number" ? p.joinedAt : 0 }));
	const now = Date.now();
	return {
		version: 1,
		sessionId,
		principal: r.principal,
		participants,
		createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
	};
}

/** La sala de un chat (sin los agentes borrados), o null si el chat no es una sala. */
export function getRoom(sessionId: string, agents: Pick<AgentProfile, "id">[]): RoomState | null {
	if (!isValidSessionId(sessionId)) return null;
	const file = roomFile(sessionId);
	if (!existsSync(file)) return null;
	let room: RoomState | null = null;
	try {
		room = parseRoom(JSON.parse(readFileSync(file, "utf-8")), sessionId);
	} catch {
		return null;
	}
	return room ? pruneRoom(room, agents) : null;
}

export function saveRoom(room: RoomState): void {
	const file = roomFile(room.sessionId);
	mkdirSync(ROOMS_DIR, { recursive: true });
	writeFileSync(file, JSON.stringify({ ...room, updatedAt: Date.now() }, null, 2) + "\n", "utf-8");
}

export function deleteRoom(sessionId: string): void {
	if (!isValidSessionId(sessionId)) return;
	rmSync(roomFile(sessionId), { force: true });
}
