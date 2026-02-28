import type { Message } from "./Types.js";
import type { LongTermSummary } from "./Types.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { eventsToContextLines } from "../memory/serializers.js";
import { getSoul } from "../soul/soul.js";
import { getToolsDefinition } from "../tools/ToolRegistry.js";
import { isSafeMode } from "../health/HealthManager.js";

export type UserProfileInput = {
	userName?: string;
	language?: string;
	about?: string;
	extra?: string;
};

export type ContextInput = {
	goal: string;
	agentName: string;
	shortMemory: MemoryStore;
	tokenBudget: number;
	toolsManifest?: string;
	workspaceContext?: string;
	/** Si true, no se incluyen herramientas en el contexto (solo respuesta en texto). */
	textOnly?: boolean;
	/** Perfil del usuario para personalizar respuestas (nombre, idioma, sobre ti). */
	userProfile?: UserProfileInput | null;
};

/** Prioridad: SOUL > goal > short memory > tool context > long memory. Truncado por tokenBudget (approx 4 chars/token). */
export function buildContext(input: ContextInput): { system: string; messages: Message[] } {
	const approxCharsPerToken = 4;
	const budgetChars = Math.floor(input.tokenBudget * approxCharsPerToken);

	const textOnly = input.textOnly === true;
	const soul = getSoul(input.agentName, textOnly);
	const safeNote = isSafeMode() ? "\n[Safe-mode activo.]" : "";

	let remaining = budgetChars - soul.length - safeNote.length - 200;
	if (remaining < 500) remaining = 500;

	const userBlock = input.userProfile && (input.userProfile.userName || input.userProfile.about || input.userProfile.language || input.userProfile.extra)
		? (() => {
				const p = input.userProfile!;
				const parts: string[] = [];
				if (p.userName) parts.push("Nombre: " + p.userName);
				if (p.language) parts.push("Idioma preferido: " + p.language);
				if (p.about) parts.push("Sobre la persona: " + p.about);
				if (p.extra) parts.push("Notas: " + p.extra);
				const text = "## Sobre el usuario\n" + parts.join("\n");
				remaining -= text.length;
				return "\n\n" + text;
			})()
		: "";
	const goalBlock = `## Mensaje del usuario\n${input.goal}`;
	remaining -= goalBlock.length;

	const toolBlock = textOnly
		? ""
		: (() => {
				const toolsDef = getToolsDefinition(true);
				const toolsManifest =
					input.toolsManifest ??
					toolsDef.map((t) => t.function.name + ": " + (t.function.description ?? "")).join("; ");
				return `## Herramientas disponibles\n${toolsManifest}`;
			})();
	if (toolBlock) remaining -= toolBlock.length;

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
		userBlock +
		"\n\n" +
		goalBlock +
		(toolBlock ? "\n\n" + toolBlock : "") +
		(shortBlock ? "\n\n## Eventos recientes\n" + shortBlock : "") +
		(longBlock ? "\n\n" + longBlock : "") +
		workspace;

	// Mensaje de usuario: si textOnly, añadimos instrucción para que el modelo responda con texto
	const userContent =
		textOnly
			? `${input.goal}\n\n(Responde en una o dos frases, de forma natural.)`
			: input.goal;
	const messages: Message[] = [{ role: "user", content: userContent }];
	return { system, messages };
}
