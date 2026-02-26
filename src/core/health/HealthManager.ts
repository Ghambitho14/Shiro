import type { AgentEvent } from "../agent/Types.js";
import { detectLoop, type LoopSignal } from "./LoopDetector.js";
import { metrics } from "./metrics.js";
import { setToolsEnabled } from "../tools/ToolRegistry.js";

export type HealthState = {
	status: "normal" | "safe_mode" | "paused";
	lastLoopSignal: LoopSignal;
	consecutiveErrors: number;
	lastActive: string;
};

const state: HealthState = {
	status: "normal",
	lastLoopSignal: "ok",
	consecutiveErrors: 0,
	lastActive: new Date().toISOString(),
};

export function setHealthActive(): void {
	state.lastActive = new Date().toISOString();
}

export function getHealthState(): HealthState {
	return { ...state };
}

export function recordError(): void {
	metrics.errors++;
	state.consecutiveErrors++;
}

export function recordSuccess(): void {
	state.consecutiveErrors = 0;
}

/** Observa eventos recientes e interviene si detecta loop. */
export function checkAndIntervene(events: AgentEvent[]): { intervened: boolean; action?: string } {
	const { signal, detail } = detectLoop(events);
	state.lastLoopSignal = signal;

	if (signal === "ok") {
		return { intervened: false };
	}

	metrics.loopInterventions++;

	if (signal === "same_error" && state.consecutiveErrors >= 2) {
		state.status = "safe_mode";
		// Desactivar herramientas de escritura en sistema (más peligrosas)
		setToolsEnabled(["write_file_system", "list_dir_system"], false);
		return { intervened: true, action: "safe_mode: disabled system write tools" };
	}

	if (signal === "same_action" || signal === "no_progress") {
		// Cambiar estrategia: no desactivar todo, pero el agente puede pedir input
		return { intervened: true, action: `loop_detected: ${signal} (${detail ?? ""}). Consider asking user.` };
	}

	return { intervened: false };
}

export function setSafeMode(enabled: boolean): void {
	state.status = enabled ? "safe_mode" : "normal";
	if (!enabled) {
		setToolsEnabled(["write_file_system", "list_dir_system"], true);
	}
}

export function isSafeMode(): boolean {
	return state.status === "safe_mode";
}
