import type { Message } from "./Types.js";
import type { AgentEvent } from "./Types.js";
import type { LLMClient } from "../llm/LLMClient.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { buildContext } from "./ContextBuilder.js";
import { plan } from "./Planner.js";
import { executeStep } from "./Executor.js";
import {
	executeToolSafeScoped,
	getToolsDefinitionScoped,
} from "../tools/ToolRegistry.js";

import { checkAndIntervene } from "../health/HealthManager.js";
import { policies } from "../soul/policies.js";
import { logger } from "../logger.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";

export type UserProfileForAgent = {
	userName?: string;
	language?: string;
	about?: string;
	extra?: string;
};

export type AgentOptions = {
	llm: LLMClient;
	memory: MemoryStore;
	agentName: string;
	tokenBudget?: number;
	usePlanner?: boolean;
	textOnly?: boolean;
	allowedTools?: string[];
	conversation?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Perfil del usuario (para personalizar respuestas). */
	userProfile?: UserProfileForAgent | null;
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
		textOnly = false,
		allowedTools,
		conversation,
		userProfile,
	} = opts;

	const runId = `run_${Date.now()}`;

	const isSimpleGreeting = (text: string): boolean => {
		const t = text.trim().toLowerCase().replace(/\s+/g, " ");
		return (
			t.length < 80 &&
			(/^(hola|hey|hi|buenas|qué tal|qué hubo|hello|saludos|buen día|buenas tardes|buenas noches)[\s!?.,]*$/i.test(t) ||
				/^((hola|hey|hi),?\s*)+[!.]?\s*$/i.test(t))
		);
	};
	const effectiveUsePlanner = usePlanner && !isSimpleGreeting(goal);

	const pushEvent = (type: AgentEvent["type"], payload: Record<string, unknown>, stepId?: string) => {
		memory.push({
			type,
			timestamp: new Date().toISOString(),
			runId,
			stepId,
			payload,
		});
	};

	pushEvent("decision", { goal, usePlanner: effectiveUsePlanner });

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
		textOnly,
		userProfile: userProfile ?? undefined,
	});

	const normalizedConversation = Array.isArray(conversation)
		? conversation
			.map((m) => ({ role: m.role, content: m.content?.trim() ?? "" }))
			.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.length > 0)
		: [];
	const fullMessages: Message[] = normalizedConversation.length > 0
		? [{ role: "system", content: system }, ...normalizedConversation]
		: [{ role: "system", content: system }, ...messages];
	const toolsDef = getToolsDefinitionScoped(allowedTools);
	const adaptToolResult = (
		name: string,
		args: Record<string, unknown>,
	): { ok: boolean; content: string; error?: string } => {
		const r = executeToolSafeScoped(name, args, allowedTools);
		return {
			ok: r.ok,
			content: r.ok ? r.content : r.error,
			error: r.ok ? undefined : r.error,
		};
	};

	if (effectiveUsePlanner && policies.maxStepsPerRun > 0) {
		const steps = await plan(llm, goal, agentName);
		logger.info("Plan generado", { steps: steps.length });
		pushEvent("plan", { steps });
		let lastContent = "";
		for (let i = 0; i < Math.min(steps.length, policies.maxStepsPerRun); i++) {
			const stepGoal = steps[i];
			const stepId = `step_${i}`;
			pushEvent("tool_call", { name: "planner_step", step: stepGoal }, stepId);
			const result = await executeStep(llm, stepGoal, fullMessages, adaptToolResult, toolsDef);
			if (!result.ok) {
				pushEvent("error", { content: result.error }, stepId);
				return result.error;
			}
			lastContent = result.content;
			fullMessages.push({ role: "user", content: stepGoal });
			fullMessages.push({ role: "assistant", content: result.content });
			pushEvent("observation", { content: result.content }, stepId);
		}
		return sanitizeModelResponse(lastContent);
	}

	// Modo directo: puede usar herramientas si textOnly === false
	try {
		const content = textOnly
			? (await llm.chat(fullMessages)).trim()
			: (await llm.chatWithTools(fullMessages, toolsDef, adaptToolResult)).trim();
		const out = sanitizeModelResponse(content || "");
		pushEvent("observation", { content: out });
		return out;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		pushEvent("error", { content: msg });
		throw err;
	}
}
