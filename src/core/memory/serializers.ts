import type { AgentEvent } from "../agent/Types.js";
import type { Message } from "../agent/Types.js";

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
export function eventsToMessages(events: AgentEvent[]): Message[] {
	const out: Message[] = [];
	for (const e of events) {
		if (e.type === "tool_call" && typeof e.payload.name === "string") {
			out.push({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: String(e.payload.id ?? ""),
						type: "function",
						function: {
							name: e.payload.name as string,
							arguments: typeof e.payload.arguments === "string" ? e.payload.arguments : "{}",
						},
					},
				],
			});
		} else if (e.type === "observation" || e.type === "error") {
			const content = typeof e.payload.content === "string" ? e.payload.content : JSON.stringify(e.payload);
			out.push({
				role: "tool",
				tool_call_id: String(e.payload.tool_call_id ?? ""),
				content,
			});
		}
	}
	return out;
}
