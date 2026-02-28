import type { Message } from "./Types.js";
import type { LLMClient, ExecuteToolFn, ToolDef } from "../llm/LLMClient.js";
import { getToolsDefinition } from "../tools/ToolRegistry.js";
import { metrics } from "../health/metrics.js";
import { recordError, recordSuccess } from "../health/HealthManager.js";

export type ExecutorResult = { ok: true; content: string } | { ok: false; error: string };

/** Ejecuta un solo paso (objetivo o sub-objetivo) usando el LLM y las tools. */
export async function executeStep(
	llm: LLMClient,
	stepGoal: string,
	messagesSoFar: Message[],
	executeTool: ExecuteToolFn,
	toolsDef?: ToolDef[],
): Promise<ExecutorResult> {
	const effectiveToolsDef = toolsDef ?? getToolsDefinition(true);
	const fullMessages: Message[] = [...messagesSoFar, { role: "user", content: stepGoal }];

	try {
		const content = await llm.chatWithTools(fullMessages, effectiveToolsDef, ((name, args) => {
			metrics.toolCalls++;
			const r = executeTool(name, args);
			if (!r.ok) {
				recordError();
				return { ok: false, content: r.error, error: r.error };
			}
			recordSuccess();
			return { ok: true, content: r.content, error: undefined };
		}) as ExecuteToolFn);
		recordSuccess();
		return { ok: true, content: content.trim() || "(Sin respuesta de texto)" };
	} catch (err) {
		recordError();
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}
