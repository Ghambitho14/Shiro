/**
 * Órdenes de las salas dichas con palabras (sin modelo): "Aku, activa Viernes", "Viernes, agrega a Lunes",
 * "gracias Lunes, puedes irte", "Lunes, ahora te encargas tú"… y quién responde cada mensaje.
 *
 * Todo se compara sin tildes ni mayúsculas. Una orden solo vale con el nombre de un agente que existe:
 * "activa el wifi" no es una orden de sala y sigue al asistente de siempre.
 */
import { agentNames, type AgentProfile } from "../agents/registry.js";
import { normalizeText } from "../agents/text.js";
import type { RoomState } from "./roomStore.js";

export type RoomIntent =
	| { kind: "activate"; agentId: string; rest?: string }
	| { kind: "add"; agentId: string; rest?: string }
	| { kind: "dismiss"; agentId: string }
	| { kind: "promote"; agentId: string }
	| { kind: "close" }
	/** Solo la palabra de activación ("Aku" o "Aku, activa"), sin decir a quién. */
	| { kind: "wakeOnly" }
	/** Un mensaje normal dentro de una sala: quién lo responde. */
	| { kind: "route"; agentId: string; mentioned: boolean };

export type IntentContext = {
	agents: Pick<AgentProfile, "id" | "name" | "aliases">[];
	room: RoomState | null;
	/** Palabra de activación y nombre del asistente ("aku", "shiro"): se quitan del principio. */
	wakeWords: string[];
};

/** Las órdenes son frases cortas: un texto más largo es una pregunta normal. */
const MAX_COMMAND_CHARS = 120;

/**
 * Palabras que, delante de un nombre, indican que no se habla de un agente:
 * "recuérdame el lunes", "para el viernes", "hasta el próximo lunes".
 */
const NOT_A_MENTION = new Set([
	"el", "la", "los", "las", "un", "una", "este", "esta", "ese", "esa", "aquel", "proximo", "proxima",
	"cada", "otro", "otra", "de", "del", "al", "hasta", "desde", "para", "por", "todos", "todas", "hoy", "manana",
]);

const ACTIVATE = "activa|activar|activame|despierta|despiertame|quiero hablar con|hablar con|habla con|abre una sala con|abre sala con|ponme con|pasame con|conectame con";
const ADD = "agrega|agregar|agregame|anade|anademe|suma|sumale|sumame|invita|invitame|trae|traeme|llama|llamame|une|unele";
const DISMISS_PHRASE =
	"puedes irte|ya puedes irte|te puedes ir|ya te puedes ir|puedes retirarte|ya puedes retirarte|vete|ya vete|retirate|eso es todo|eso seria todo|sal de la sala|ya no te necesito|nos vemos";
const DISMISS_VERB = "saca|sacame|quita|quitame|despide|despideme|echa|elimina";
const PROMOTE_PHRASE =
	"ahora te encargas tu|te encargas tu|encargate tu|encargate|ahora te toca|te toca|toma el mando|tomas el mando|ahora mandas tu|mandas tu|quedate a cargo|te quedas a cargo|ahora eres el principal|ahora eres la principal|eres el principal|eres la principal";
const THANKS = "muchas gracias|gracias|chao|adios|hasta luego|listo|bueno|ok|vale";

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLead(t: string, words: string[]): { text: string; woke: boolean } {
	const alts = words.map((w) => normalizeText(w)).filter(Boolean).map(escapeRe);
	if (!alts.length) return { text: t, woke: false };
	const re = new RegExp(`^(?:(?:oye|hey|ey|hola|ok|okey) )?(?:${alts.join("|")})(?: |$)`);
	const m = t.match(re);
	return m ? { text: t.slice(m[0].length).trim(), woke: true } : { text: t, woke: false };
}

function stripPoliteness(t: string): string {
	return t.replace(/(?: por favor| porfa| porfis| porfavor)$/, "").replace(/^(?:por favor|porfa) /, "").trim();
}

/** Detecta una orden de sala o, si el chat ya es una sala, quién responde. null = nada que ver con salas. */
export function detectRoomIntent(text: string, ctx: IntentContext): RoomIntent | null {
	const byName = new Map<string, string>();
	for (const a of ctx.agents) for (const n of agentNames(a)) if (!byName.has(n)) byName.set(n, a.id);
	const names = [...byName.keys()].sort((a, b) => b.length - a.length);

	const full = normalizeText(text);
	const { text: afterWake, woke } = stripLead(full, ctx.wakeWords);
	const t = stripPoliteness(afterWake);

	if (woke && /^(?:|activa|activate|despierta|despiertate|hola|estas ahi|me escuchas)$/.test(t)) return { kind: "wakeOnly" };

	if (names.length && t.length <= MAX_COMMAND_CHARS) {
		const command = matchCommand(t, names, byName, ctx.room);
		if (command) return command;
	}
	if (!ctx.room) return null;
	const mention = findMention(text, ctx);
	return mention ? { kind: "route", agentId: mention, mentioned: true } : { kind: "route", agentId: ctx.room.principal, mentioned: false };
}

function matchCommand(t: string, names: string[], byName: Map<string, string>, room: RoomState | null): RoomIntent | null {
	const NAME = `(${names.map(escapeRe).join("|")})`;
	const id = (n: string | undefined) => (n ? byName.get(n) : undefined);
	const REST = "(?: (?:y|e|para que|y que) (.+))?";
	const inRoom = (agentId: string) => room?.participants.some((p) => p.agentId === agentId) ?? false;

	let m: RegExpMatchArray | null;
	// Activar o sumar: sin sala, las dos crean la sala; con sala, las dos suman al agente.
	if ((m = t.match(new RegExp(`^(?:${ACTIVATE})(?: a)? ${NAME}(?: (?:a|en) (?:la )?sala)?${REST}$`)))) {
		const agentId = id(m[1])!;
		return room ? { kind: "add", agentId, rest: m[2] } : { kind: "activate", agentId, rest: m[2] };
	}
	if (
		(m = t.match(new RegExp(`^(?:${ADD})(?: a)? ${NAME}(?: (?:a|en) (?:la )?sala)?${REST}$`))) ||
		(m = t.match(new RegExp(`^que (?:se una|venga|entre) ${NAME}${REST}$`)))
	) {
		const agentId = id(m[1])!;
		return room ? { kind: "add", agentId, rest: m[2] } : { kind: "activate", agentId, rest: m[2] };
	}
	// Despedir: "gracias Lunes, puedes irte", "puedes irte Lunes", "saca a Lunes".
	if (
		(m = t.match(new RegExp(`^(?:(?:${THANKS}) )*${NAME} (?:(?:${THANKS}) )*(?:${DISMISS_PHRASE})$`))) ||
		(m = t.match(new RegExp(`^(?:(?:${THANKS}) )*(?:${DISMISS_PHRASE}) ${NAME}$`))) ||
		(m = t.match(new RegExp(`^(?:${DISMISS_VERB})(?: a)? ${NAME}(?: de la sala)?$`)))
	) {
		const agentId = id(m[1])!;
		return room && inRoom(agentId) ? { kind: "dismiss", agentId } : null;
	}
	// Cambiar de principal: "Lunes, ahora te encargas tú", "pásale el mando a Lunes".
	if (
		(m = t.match(new RegExp(`^${NAME} (?:${PROMOTE_PHRASE})$`))) ||
		(m = t.match(new RegExp(`^(?:${PROMOTE_PHRASE}) ${NAME}$`))) ||
		(m = t.match(new RegExp(`^(?:pasale|pasa|dale|cedele) el mando a ${NAME}$`))) ||
		(m = t.match(new RegExp(`^que se encargue ${NAME}$`))) ||
		(m = t.match(new RegExp(`^haz (?:principal a ${NAME}|a ${NAME} (?:el|la) principal)$`)))
	) {
		const agentId = id(m[1] ?? m[2])!;
		return { kind: "promote", agentId };
	}
	if (room && /^(?:(?:cierra|cerrar|termina|terminar|terminemos) (?:la )?sala|(?:adios|chao|hasta luego) a todos)$/.test(t)) {
		return { kind: "close" };
	}
	// "Viernes, agrega a Lunes": el nombre del principio solo dice a quién se le habla.
	if ((m = t.match(new RegExp(`^${NAME} (.+)$`)))) {
		const inner = matchCommand(m[2], names, byName, room);
		if (inner && inner.kind !== "route") return inner;
	}
	return null;
}

/** El primer agente de la sala nombrado en el mensaje (palabra completa o @nombre), o null. */
function findMention(text: string, ctx: IntentContext): string | null {
	const room = ctx.room!;
	const present = ctx.agents.filter((a) => room.participants.some((p) => p.agentId === a.id));
	const tokens = normalizeText(text, true).split(" ").filter(Boolean);
	const candidates = present.flatMap((a) => agentNames(a).map((n) => ({ id: a.id, words: n.split(" ") })));
	candidates.sort((a, b) => b.words.length - a.words.length);
	for (let i = 0; i < tokens.length; i++) {
		const at = tokens[i].startsWith("@");
		for (const c of candidates) {
			const first = at ? tokens[i].slice(1) : tokens[i];
			if (first !== c.words[0]) continue;
			if (!c.words.every((w, k) => k === 0 || tokens[i + k] === w)) continue;
			// Con @ siempre es una mención; si no, "el lunes" o "para el viernes" son días.
			if (at || i === 0 || !NOT_A_MENTION.has(tokens[i - 1])) return c.id;
		}
	}
	return null;
}
