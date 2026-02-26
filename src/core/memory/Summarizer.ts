import type { AgentEvent, LongTermSummary } from "../agent/Types.js";

/** Resume una ventana de eventos en texto + keyFacts + openTasks. Por ahora simple (concat). */
export function summarize(events: AgentEvent[]): LongTermSummary {
	const parts: string[] = [];
	const keyFacts: string[] = [];
	const openTasks: string[] = [];

	for (const e of events) {
		if (e.type === "observation" && typeof e.payload.content === "string") {
			parts.push(e.payload.content.slice(0, 500));
		}
		if (e.type === "decision" && typeof e.payload.reason === "string") {
			keyFacts.push(e.payload.reason);
		}
		// TODO: extraer openTasks de texto (ej. "pendiente: X")
	}

	return {
		summary: parts.join(" | ").slice(0, 2000) || "Sin resumen.",
		keyFacts,
		openTasks,
	};
}
