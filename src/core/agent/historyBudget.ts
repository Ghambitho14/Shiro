/**
 * Cuánta conversación anterior se manda al modelo en cada respuesta (Ajustes → Modelo →
 * "Conversación que se envía"). El chat completo se sigue guardando: solo se manda menos.
 * Cada vuelta con herramientas reenvía todo, así que un chat largo gasta muchísimo.
 */
import type { Message } from "./Types.js";

/** Tokens aproximados de un texto (en español salen unos 3,5 caracteres por token). */
export const approxTokens = (chars: number) => Math.ceil(chars / 3.5);

/** Lo que cuenta una imagen adjunta, más o menos. */
const IMAGE_TOKENS = 800;

/** En la nube (o si no se sabe el contexto), "automático" manda como mucho esto. */
export const CLOUD_HISTORY_TOKENS = 16_000;
/** Nunca se deja menos que esto en automático, aunque el contexto vaya justo. */
const MIN_HISTORY_TOKENS = 1_500;

export function messageTokens(m: Message): number {
	const c = m.content as unknown;
	if (typeof c === "string") return approxTokens(c.length) + 4;
	if (!Array.isArray(c)) return 4;
	let n = 4;
	for (const p of c as { type?: string; text?: string }[]) {
		n += p.type === "text" ? approxTokens(p.text?.length ?? 0) : IMAGE_TOKENS;
	}
	return n;
}

/**
 * El presupuesto para la conversación.
 * - `setting` > 0: el que eligió el usuario.
 * - 0 (automático): en modelos locales, lo que quede del contexto después de las instrucciones,
 *   las herramientas y lo que se reserva para la respuesta; en la nube, CLOUD_HISTORY_TOKENS.
 */
export function historyBudget(opts: { setting: number; local: boolean; contextWindow: number; fixedChars: number; reserveTokens?: number }): number {
	if (opts.setting > 0) return opts.setting;
	if (!opts.local || !opts.contextWindow) return CLOUD_HISTORY_TOKENS;
	const free = opts.contextWindow - approxTokens(opts.fixedChars) - (opts.reserveTokens ?? 1024);
	return Math.max(MIN_HISTORY_TOKENS, Math.min(free, CLOUD_HISTORY_TOKENS * 2));
}

/**
 * Deja los últimos mensajes que caben en `budget` tokens. Siempre queda el último mensaje (lo
 * que el usuario acaba de escribir) y lo que se manda empieza por un mensaje del usuario.
 */
export function trimHistory(messages: Message[], budget: number): Message[] {
	if (messages.length <= 1) return messages;
	let used = messageTokens(messages[messages.length - 1]);
	let start = messages.length - 1;
	while (start > 0) {
		const next = used + messageTokens(messages[start - 1]);
		if (next > budget) break;
		used = next;
		start--;
	}
	while (start < messages.length - 1 && messages[start].role !== "user") start++;
	return start === 0 ? messages : messages.slice(start);
}
