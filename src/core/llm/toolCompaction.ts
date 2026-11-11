/**
 * En un trabajo largo cada vuelta reenvía todos los resultados de herramientas anteriores, y el
 * contexto se llena. Aquí se recortan los viejos (queda su principio y un aviso) dejando enteros los
 * últimos: el modelo ya sacó de ellos lo que necesitaba, y si no, puede volver a pedirlos.
 */
import type { Message } from "../agent/Types.js";

export const COMPACTED_NOTE = "[resultado anterior recortado para ahorrar contexto; si lo necesitas, vuelve a pedirlo]";
/** Lo que queda de un resultado recortado. */
const KEEP_HEAD_CHARS = 300;

/** ¿Es un resultado de herramienta? (mensaje `tool`, o el de usuario con `<tool_result>` del modo texto) */
function isToolResult(m: Message): m is Message & { content: string } {
	if (typeof m.content !== "string") return false;
	return m.role === "tool" || (m.role === "user" && m.content.startsWith("<tool_result"));
}

/** Las instrucciones de una habilidad hacen falta hasta el final: no se recortan. */
function isProtected(m: Message & { content: string }): boolean {
	return (m as { name?: string }).name === "use_skill" || m.content.startsWith('<tool_result name="use_skill"');
}

/**
 * Recorta en `msgs` (desde `from`, donde empiezan los de esta respuesta) los resultados más viejos
 * hasta que todos juntos quepan en `budgetChars`. Los últimos `keep` no se tocan. Devuelve cuántos recortó.
 */
export function compactToolResults(msgs: Message[], from: number, budgetChars: number, keep = 2): number {
	const idx: number[] = [];
	let total = 0;
	for (let i = from; i < msgs.length; i++) {
		const m = msgs[i]!;
		if (!isToolResult(m)) continue;
		idx.push(i);
		total += m.content.length;
	}
	let compacted = 0;
	for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
		if (total <= budgetChars) break;
		const m = msgs[i] as Message & { content: string };
		if (isProtected(m) || m.content.endsWith(COMPACTED_NOTE)) continue;
		const short = `${m.content.slice(0, KEEP_HEAD_CHARS)}\n…\n${COMPACTED_NOTE}`;
		if (short.length >= m.content.length) continue;
		total -= m.content.length - short.length;
		msgs[i] = { ...m, content: short } as Message;
		compacted++;
	}
	return compacted;
}
