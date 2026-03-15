import type { AgentEvent } from "../agent/Types.js";

const SAME_ACTION_THRESHOLD = 3;
const SAME_ERROR_THRESHOLD = 2;
const NO_PROGRESS_THRESHOLD = 3;

export type LoopSignal = "ok" | "same_action" | "same_error" | "no_progress";

export function detectLoop(events: AgentEvent[]): { signal: LoopSignal; detail?: string } {
	if (events.length < 2) return { signal: "ok" };

	// Misma tool/action >= 3
	const toolCalls = events.filter((e) => e.type === "tool_call");
	if (toolCalls.length >= SAME_ACTION_THRESHOLD) {
		const names = toolCalls
			.slice(-SAME_ACTION_THRESHOLD)
			.map((e) => String(e.payload.name ?? e.payload.step ?? "").trim());
		const allSame = names[0].length > 0 && names.every((n) => n === names[0]);
		if (allSame) {
			return { signal: "same_action", detail: String(names[0]) };
		}
	}

	// Mismo error consecutivo >= 2
	const errors = events.filter((e) => e.type === "error");
	if (errors.length >= SAME_ERROR_THRESHOLD) {
		const lastErrors = errors.slice(-SAME_ERROR_THRESHOLD).map((e) => e.payload.error ?? e.payload.content);
		const allSame = lastErrors.every((v) => v === lastErrors[0]);
		if (allSame) {
			return { signal: "same_error", detail: String(lastErrors[0]).slice(0, 100) };
		}
	}

	// No progreso: mismo "estado" (últimas observaciones muy similares)
	const observations = events.filter((e) => e.type === "observation");
	if (observations.length >= NO_PROGRESS_THRESHOLD) {
		const contents = observations.slice(-NO_PROGRESS_THRESHOLD).map((e) => String(e.payload.content ?? "").slice(0, 80));
		const allSame = contents.every((c) => c === contents[0]);
		if (allSame) {
			return { signal: "no_progress", detail: contents[0]?.slice(0, 60) };
		}
	}

	return { signal: "ok" };
}
