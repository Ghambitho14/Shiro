import type { AgentEvent, LongTermSummary } from "../agent/Types.js";

export interface MemoryStore {
	/** Añade evento a corto plazo (rolling window). */
	push(event: AgentEvent): void;

	/** Últimos N eventos (corto plazo). */
	getRecent(n: number): AgentEvent[];

	/** Resumen de largo plazo (después de summarizer). */
	getLongTerm(): LongTermSummary | null;

	/** Actualiza el resumen de largo plazo. */
	setLongTerm(summary: LongTermSummary): void;

	/** Limpia solo la memoria de corto plazo (no el resumen). */
	clearShort(): void;
}
