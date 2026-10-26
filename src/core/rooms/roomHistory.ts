/**
 * Historial de una sala para el agente que responde: sus mensajes van como suyos ("assistant") y
 * los de los demás agentes como "[Lunes]: …" (el modelo solo conoce usuario y asistente).
 * Se recorta a los últimos mensajes que caben, sin quitar nunca el último del usuario.
 */
import type { ContentPart } from "../agent/Types.js";
import { getMessagePreview } from "../agent/contentUtils.js";

export type RoomMessage = { role: "user" | "assistant"; content: string | ContentPart[]; agent?: string; agentName?: string };
export type ConversationMessage = { role: "user" | "assistant"; content: string | ContentPart[] };

type Piece = { label: string | null; content: string | ContentPart[] };

function labeled(label: string | null, text: string): string {
	return label ? `[${label}]: ${text}` : text;
}

/** Junta varios trozos (del usuario y de otros agentes) en un solo mensaje de usuario. */
function mergePieces(pieces: Piece[]): string | ContentPart[] {
	// Si solo habla el usuario, va tal cual (sin "[Usuario]:").
	const needLabels = pieces.some((p) => p.label !== null && p.label !== "Usuario");
	const label = (p: Piece) => (needLabels ? p.label : null);
	if (pieces.length === 1 && !needLabels) return pieces[0].content;
	if (pieces.every((p) => typeof p.content === "string")) {
		return pieces.map((p) => labeled(label(p), p.content as string)).join("\n\n");
	}
	const parts: ContentPart[] = [];
	for (const p of pieces) {
		if (typeof p.content === "string") {
			parts.push({ type: "text", text: labeled(label(p), p.content) });
			continue;
		}
		let first = true;
		for (const part of p.content) {
			if (part.type === "text" && first) {
				parts.push({ type: "text", text: labeled(label(p), part.text) });
				first = false;
			} else parts.push(part);
		}
		if (first && label(p)) parts.unshift({ type: "text", text: `[${label(p)}]:` });
	}
	return parts;
}

function size(content: string | ContentPart[]): number {
	return getMessagePreview(content).length;
}

export function buildRoomHistory(
	messages: RoomMessage[],
	responderId: string,
	/** Nombre para mostrar de un agente (sin id: el asistente de siempre). */
	nameOf: (agentId: string | undefined, m: RoomMessage) => string,
	opts: { maxMessages?: number; maxChars?: number } = {},
): { conversation: ConversationMessage[]; omitted: number } {
	const maxMessages = opts.maxMessages ?? 30;
	const maxChars = opts.maxChars ?? 24_000;

	// Grupos: cada respuesta propia es un "assistant"; lo demás seguido se junta en un "user".
	type Group = { role: "user" | "assistant"; pieces: Piece[]; count: number };
	const groups: Group[] = [];
	for (const m of messages) {
		if (m.role === "assistant" && m.agent === responderId) {
			groups.push({ role: "assistant", pieces: [{ label: null, content: m.content }], count: 1 });
			continue;
		}
		const piece: Piece = m.role === "user" ? { label: "Usuario", content: m.content } : { label: nameOf(m.agent, m), content: m.content };
		const last = groups[groups.length - 1];
		if (last?.role === "user") {
			last.pieces.push(piece);
			last.count++;
		} else groups.push({ role: "user", pieces: [piece], count: 1 });
	}

	const total = messages.length;
	let kept = groups;
	// Primero el número de mensajes, luego el espacio. El último grupo se queda siempre.
	let count = 0;
	let start = kept.length;
	while (start > 0 && count + kept[start - 1].count <= maxMessages) {
		start--;
		count += kept[start].count;
	}
	if (start === kept.length && kept.length) start = kept.length - 1;
	kept = kept.slice(start);
	const sizeOf = (g: Group) => g.pieces.reduce((n, p) => n + size(p.content), 0);
	let chars = kept.reduce((n, g) => n + sizeOf(g), 0);
	while (kept.length > 1 && chars > maxChars) {
		chars -= sizeOf(kept[0]);
		kept = kept.slice(1);
	}
	// Los modelos esperan que la conversación empiece por el usuario.
	while (kept.length > 1 && kept[0].role === "assistant") kept = kept.slice(1);

	const conversation = kept.map((g): ConversationMessage =>
		g.role === "assistant" ? { role: "assistant", content: g.pieces[0].content } : { role: "user", content: mergePieces(g.pieces) },
	);
	const omitted = total - kept.reduce((n, g) => n + g.count, 0);
	return { conversation, omitted };
}
