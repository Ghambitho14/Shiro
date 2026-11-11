/**
 * En un trabajo largo cada vuelta reenvía todos los resultados de herramientas anteriores, y el
 * contexto se llena. Aquí se recortan los viejos (queda su principio y un aviso) dejando enteros los
 * últimos. Antes de recortar, client.ts le pide al modelo un resumen de lo que había en ellos
 * (`summaryPrompt`) y ese resumen se queda en el primero: así no pierde los datos que encontró.
 */
import type { Message } from "../agent/Types.js";

export const COMPACTED_NOTE = "[resultado anterior recortado para ahorrar contexto; si lo necesitas, vuelve a pedirlo]";
export const SUMMARY_MARK = "[Resumen de lo que había en los resultados recortados]";
/** Lo que queda de un resultado recortado. */
const KEEP_HEAD_CHARS = 300;
/** Lo que se manda de cada resultado, y de todos juntos, al pedir el resumen. */
const SUMMARY_EACH_CHARS = 4000;
const SUMMARY_TOTAL_CHARS = 24_000;
/** Un resumen más largo que esto se corta. */
const SUMMARY_MAX_CHARS = 1500;

/** ¿Es un resultado de herramienta? (mensaje `tool`, o el de usuario con `<tool_result>` del modo texto) */
function isToolResult(m: Message): m is Message & { content: string } {
	if (typeof m.content !== "string") return false;
	return m.role === "tool" || (m.role === "user" && m.content.startsWith("<tool_result"));
}

/** Las instrucciones de una habilidad hacen falta hasta el final: no se recortan. */
function isProtected(m: Message & { content: string }): boolean {
	return (m as { name?: string }).name === "use_skill" || m.content.startsWith('<tool_result name="use_skill"');
}

const shorten = (content: string) => `${content.slice(0, KEEP_HEAD_CHARS)}\n…\n${COMPACTED_NOTE}`;

/** Qué resultados (índices en `msgs`) se recortarían para que todos quepan en `budgetChars`. Los últimos `keep` no se tocan. */
export function compactable(msgs: Message[], from: number, budgetChars: number, keep = 2): number[] {
	const idx: number[] = [];
	let total = 0;
	for (let i = from; i < msgs.length; i++) {
		const m = msgs[i]!;
		if (!isToolResult(m)) continue;
		idx.push(i);
		total += m.content.length;
	}
	const out: number[] = [];
	for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
		if (total <= budgetChars) break;
		const m = msgs[i] as Message & { content: string };
		if (isProtected(m) || m.content.endsWith(COMPACTED_NOTE)) continue;
		const saved = m.content.length - shorten(m.content).length;
		if (saved <= 0) continue;
		total -= saved;
		out.push(i);
	}
	return out;
}

/**
 * Recorta en `msgs` (desde `from`, donde empiezan los de esta respuesta) los resultados más viejos
 * hasta que todos juntos quepan en `budgetChars`. Si hay `summary`, se queda en el primero que se
 * recorta. Devuelve cuántos recortó.
 */
export function compactToolResults(msgs: Message[], from: number, budgetChars: number, keep = 2, summary?: string): number {
	const idx = compactable(msgs, from, budgetChars, keep);
	const note = summary?.trim().slice(0, SUMMARY_MAX_CHARS);
	idx.forEach((i, n) => {
		const m = msgs[i] as Message & { content: string };
		const content = n === 0 && note ? `${m.content.slice(0, KEEP_HEAD_CHARS)}\n…\n${SUMMARY_MARK}\n${note}\n${COMPACTED_NOTE}` : shorten(m.content);
		msgs[i] = { ...m, content } as Message;
	});
	return idx.length;
}

/** Lo que se le pide al modelo antes de recortar: apuntar los datos de esos resultados que harán falta. */
export function summaryPrompt(msgs: Message[], indexes: number[], task: string): Message[] {
	let room = SUMMARY_TOTAL_CHARS;
	const parts: string[] = [];
	for (const i of indexes) {
		if (room <= 0) break;
		const text = String(msgs[i]!.content).slice(0, Math.min(SUMMARY_EACH_CHARS, room));
		room -= text.length;
		parts.push(`--- Resultado ${parts.length + 1} ---\n${text}`);
	}
	return [
		{
			role: "system",
			content:
				"Apuntas datos de un trabajo en curso. Responde solo con la lista, en español, sin saludo ni explicación.",
		},
		{
			role: "user",
			content: `Estos resultados de herramientas se van a borrar para ahorrar espacio. Apunta, en 12 líneas como mucho, los datos que harán falta para seguir con la tarea: rutas de archivos con su número de línea, nombres de funciones o variables, valores exactos, errores y qué quedó descartado. Solo lo que está en los resultados; no inventes.\n\nTarea: ${task.slice(0, 600) || "(no indicada)"}\n\n${parts.join("\n\n")}`,
		},
	];
}
