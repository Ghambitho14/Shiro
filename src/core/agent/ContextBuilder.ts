import type { Message } from "./Types.js";
import type { LongTermSummary } from "./Types.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { eventsToContextLines } from "../memory/serializers.js";
import { getSoul } from "../soul/soul.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { getToolsDefinition } from "../tools/ToolRegistry.js";
import { isSafeMode } from "../health/HealthManager.js";

export type ContextInput = {
	goal: string;
	agentName: string;
	shortMemory: MemoryStore;
	tokenBudget: number;
	toolsManifest?: string;
	workspaceContext?: string;
};

/** Prioridad: SOUL > goal > short memory > tool context > long memory. Truncado por tokenBudget (approx 4 chars/token). */
export function buildContext(input: ContextInput): { system: string; messages: Message[] } {
	const approxCharsPerToken = 4;
	const budgetChars = Math.floor(input.tokenBudget * approxCharsPerToken);

	const soul = getSoul(input.agentName);
	const safeNote = isSafeMode() ? "\n[Safe-mode activo: algunas herramientas deshabilitadas.]" : "";

	let remaining = budgetChars - soul.length - safeNote.length - 200;
	if (remaining < 500) remaining = 500;

	const goalBlock = `## Objetivo actual\n${input.goal}`;
	remaining -= goalBlock.length;

	const toolsDef = getToolsDefinition(true);
	const toolsManifest =
		input.toolsManifest ??
		toolsDef.map((t) => t.function.name + ": " + (t.function.description ?? "")).join("; ");
	const toolBlock = `## Herramientas disponibles\n${toolsManifest}`;
	remaining -= toolBlock.length;

	const recent = input.shortMemory.getRecent(30);
	const shortBlock = eventsToContextLines(recent, Math.min(remaining - 400, 2000));
	remaining -= shortBlock.length;

	const long = input.shortMemory.getLongTerm();
	const longBlock =
		long && remaining > 100
			? `## Memoria a largo plazo (resumen)\n${long.summary}`
			: "";

	const workspace = input.workspaceContext
		? `\n\n--- Contexto workspace ---\n${input.workspaceContext.slice(0, Math.min(remaining, 3000))}`
		: "";

	const system =
		soul +
		safeNote +
		"\n\n" +
		goalBlock +
		"\n\n" +
		toolBlock +
		(shortBlock ? "\n\n## Eventos recientes\n" + shortBlock : "") +
		(longBlock ? "\n\n" + longBlock : "") +
		workspace;

	const messages: Message[] = [{ role: "user", content: input.goal }];
	return { system, messages };
}
