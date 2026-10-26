import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";

/** Días que se guardan los registros (llevan tus mensajes y las respuestas). */
const KEEP_DAYS = 14;

export type DecisionEvent = 
	| { type: "decision"; goal: string; timestamp: string; runId: string }
	| { type: "plan"; goal: string; steps?: string[]; timestamp: string; runId: string; stepId?: string }
	| { type: "step_status"; status: "planned" | "running" | "completed" | "failed"; goal?: string; content?: string; timestamp: string; runId: string; stepId?: string }
	| { type: "tool_call"; name: string; argsKeys: string[]; timestamp: string; runId: string; stepId?: string }
	| { type: "observation"; content: string; timestamp: string; runId: string; stepId?: string }
	| { type: "error"; content: string; timestamp: string; runId: string; stepId?: string }
	| { type: "response"; content: string; timestamp: string; runId: string; stepId?: string };

export class DecisionLogger {
	private logsDir = join(DATA_DIR, "logs", "decisions");
	/** Último día en que se creó la carpeta y se borraron los registros viejos. */
	private preparedDay = "";

	/** La carpeta se crea al escribir (no al cargar el módulo) y una vez al día se borran los de hace más de KEEP_DAYS. */
	private prepare(day: string): void {
		if (this.preparedDay === day) return;
		mkdirSync(this.logsDir, { recursive: true });
		const oldest = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
		for (const name of readdirSync(this.logsDir)) {
			const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
			if (m && m[1]! < oldest) rmSync(join(this.logsDir, name), { force: true });
		}
		this.preparedDay = day;
	}

	log(event: DecisionEvent): void {
		const day = new Date().toISOString().slice(0, 10);
		try {
			this.prepare(day);
			writeFileSync(join(this.logsDir, `${day}.jsonl`), JSON.stringify(event) + "\n", { flag: "a", encoding: "utf-8" });
		} catch (err) {
			console.error("Failed to write decision log:", err);
		}
	}
}

const globalLogger = new DecisionLogger();

export function getDecisionLogger(): DecisionLogger {
	return globalLogger;
}