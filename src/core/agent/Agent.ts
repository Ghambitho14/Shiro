import type { Message } from "./Types.js";
import type { AgentEvent } from "./Types.js";
import type { LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import { plan } from "./Planner.js";
import { executeStep } from "./Executor.js";
import { executeToolSafe } from "../tools/ToolRegistry.js";

function adaptToolResult(
	name: string,
	args: Record<string, unknown>,
): { ok: boolean; content: string; error?: string } {
	const r = executeToolSafe(name, args);
	return {
		ok: r.ok,
		content: r.ok ? r.content : r.error,
		error: r.ok ? undefined : r.error,
	};
}
import { checkAndIntervene } from "../health/HealthManager.js";
import { policies } from "../soul/policies.js";
import { logger } from "../logger.js";

export type AgentOptions = {
	llm: LLMClient;
	memory: MemoryStore;
	agentName: string;
	tokenBudget?: number;
	usePlanner?: boolean;
};

/** Loop principal: opción con planner (pasos) o directo (un solo chatWithTools). */
export async function runAgent(
	goal: string,
	opts: AgentOptions,
	workspaceContext?: string,
): Promise<string> {
	const {
		llm,
		memory,
		agentName,
		tokenBudget = 8000,
		usePlanner = false,
	} = opts;

	const runId = `run_${Date.now()}`;

	const pushEvent = (type: AgentEvent["type"], payload: Record<string, unknown>, stepId?: string) => {
		memory.push({
			type,
			timestamp: new Date().toISOString(),
			runId,
			stepId,
			payload,
		});
	};

	pushEvent("decision", { goal, usePlanner });

	const recent = memory.getRecent(20);
	const { intervened, action } = checkAndIntervene(recent);
	if (intervened && action) {
		logger.warn("HealthManager intervino", { action });
		pushEvent("error", { content: action });
		return `[Intervención] ${action}. Puedes reformular tu petición.`;
	}

	const { system, messages } = buildContext({
		goal,
		agentName,
		shortMemory: memory,
		tokenBudget,
		workspaceContext,
		textOnly: true,
	});

	const fullMessages: Message[] = [{ role: "system", content: system }, ...messages];

	if (usePlanner && policies.maxStepsPerRun > 0) {
		const steps = await plan(llm, goal, agentName);
		logger.info("Plan generado", { steps: steps.length });
		pushEvent("plan", { steps });
		let lastContent = "";
		for (let i = 0; i < Math.min(steps.length, policies.maxStepsPerRun); i++) {
			const stepGoal = steps[i];
			const stepId = `step_${i}`;
			pushEvent("tool_call", { step: stepGoal }, stepId);
			const result = await executeStep(llm, stepGoal, fullMessages, adaptToolResult);
			if (!result.ok) {
				pushEvent("error", { content: result.error }, stepId);
				return result.error;
			}
			lastContent = result.content;
			fullMessages.push({ role: "user", content: stepGoal });
			fullMessages.push({ role: "assistant", content: result.content });
			pushEvent("observation", { content: result.content }, stepId);
		}
		return lastContent;
	}

	// Modo directo: responde con texto (sin herramientas)
	try {
		const content = (await llm.chat(fullMessages)).trim();
		const out = content || "";
		pushEvent("observation", { content: out });
		return out;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushEvent("error", { content: msg });
		throw err;
	}
}
