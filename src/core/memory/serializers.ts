import type { AgentEvent } from "../agent/Types.js";

/** Convierte eventos recientes en mensajes compactos para el contexto. */
export function eventsToContextLines(events: AgentEvent[], maxChars: number): string {
	const lines: string[] = [];
	let total = 0;
	for (let i = events.length - 1; i >= 0 && total < maxChars; i--) {
		const e = events[i];
		const line = `[${e.type}] ${e.timestamp} ${JSON.stringify(e.payload).slice(0, 200)}`;
		if (total + line.length > maxChars) break;
		lines.unshift(line);
		total += line.length;
	}
	return lines.join("\n");
}

/** Convierte eventos en mensajes para el LLM (solo tool_call + observation / error). */
