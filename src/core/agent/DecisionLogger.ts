import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";

export type DecisionEvent = 
	| { type: "decision"; goal: string; timestamp: string; runId: string }
	| { type: "plan"; goal: string; steps?: string[]; timestamp: string; runId: string; stepId?: string }
	| { type: "step_status"; status: "planned" | "running" | "completed" | "failed"; goal?: string; content?: string; timestamp: string; runId: string; stepId?: string }
	| { type: "tool_call"; name: string; argsKeys: string[]; timestamp: string; runId: string; stepId?: string }
	| { type: "observation"; content: string; timestamp: string; runId: string; stepId?: string }
	| { type: "error"; content: string; timestamp: string; runId: string; stepId?: string }
	| { type: "response"; content: string; timestamp: string; runId: string; stepId?: string };

export class DecisionLogger {
	private logsDir: string;
	
	constructor() {
		this.logsDir = join(DATA_DIR, "logs", "decisions");
		this.ensureDir();
	}
	
	private ensureDir(): void {
		if (!existsSync(this.logsDir)) {
			mkdirSync(this.logsDir, { recursive: true });
		}
	}
	
	private getLogFilePath(): string {
		const date = new Date().toISOString().split("T")[0];
		return join(this.logsDir, `${date}.jsonl`);
	}
	
	log(event: DecisionEvent): void {
		const line = JSON.stringify(event) + "\n";
		const filePath = this.getLogFilePath();
		
		try {
			writeFileSync(filePath, line, { flag: "a", encoding: "utf-8" });
		} catch (err) {
			console.error("Failed to write decision log:", err);
		}
	}
	
	createPushEvent(runId: string) {
		return (type: DecisionEvent["type"], payload: Record<string, unknown>, stepId?: string) => {
			const event = {
				type,
				...payload,
				timestamp: new Date().toISOString(),
				runId,
				stepId,
			} as DecisionEvent;
			this.log(event);
		};
	}
}

const globalLogger = new DecisionLogger();

export function getDecisionLogger(): DecisionLogger {
	return globalLogger;
}