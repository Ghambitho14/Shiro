import type { Message } from "./Types.js";
import type { LLMClient, ExecuteToolFn, ToolDef } from "../llm/LLMClient.js";
import { getToolsDefinition } from "../tools/ToolRegistry.js";
import { metrics } from "../health/metrics.js";
import { recordError, recordSuccess } from "../health/HealthManager.js";
import { parseToolCallsFromText } from "./ToolParser.js";

export type ExecutorResult = { ok: true; content: string } | { ok: false; error: string };

/** Ejecuta un solo paso (objetivo o sub-objetivo) usando el LLM y las tools. */
export async function executeStep(
	llm: LLMClient,
	stepGoal: string,
	messagesSoFar: Message[],
	executeTool: ExecuteToolFn,
	toolsDef?: ToolDef[],
): Promise<ExecutorResult> {
	// Primero intentar parsear tool calls del texto del goal
	const parsed = parseToolCallsFromText(stepGoal);
	if (parsed.length > 0) {
		const tool = parsed[0];
		console.log(`🔧 Ejecutando (parseado): ${tool.name}`, tool.args);
		metrics.toolCalls++;
		try {
			const result = await executeTool(tool.name, tool.args);
			if (result.ok) {
				recordSuccess();
				return { ok: true, content: result.content };
			} else {
				recordError();
				return { ok: false, error: result.error ?? "Error desconocido" };
			}
		} catch (err) {
			recordError();
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
	
	// Fallback: usar LLM con tools
	const effectiveToolsDef = toolsDef ?? getToolsDefinition(true);
	
	let fullMessages: Message[];
	const hasSystem = messagesSoFar[0]?.role === "system";
	if (hasSystem) {
		fullMessages = [...messagesSoFar, { role: "user", content: stepGoal }];
	} else {
		fullMessages = [
			{ role: "system", content: "Eres un asistente útil." },
			...messagesSoFar,
			{ role: "user", content: stepGoal }
		];
	}

	try {
		const content = await llm.chatWithTools(fullMessages, effectiveToolsDef, (async (name, args) => {
			metrics.toolCalls++;
			const r = await executeTool(name, args);
			if (!r.ok) {
				recordError();
				return { ok: false, content: r.error ?? "", error: r.error };
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
