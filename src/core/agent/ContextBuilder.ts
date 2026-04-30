import type { Message } from "./Types.js";
import type { LongTermSummary } from "./Types.js";
import type { MemoryStore } from "../memory/MemoryStore.js";
import { eventsToContextLines } from "../memory/serializers.js";
import { getSoulWithRole } from "../soul/soul.js";
import type { Role } from "../roles/roleManager.js";
import { getToolsDefinitionScoped } from "../tools/ToolRegistry.js";
import { isSafeMode } from "../health/HealthManager.js";
import { loadRelevantSkills } from "../skills/SkillLoader.js";

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
	/** Si se especifica, el system prompt lista solo estas tools. */
	allowedTools?: string[];
	/** Si true, no se incluyen herramientas en el contexto (solo respuesta en texto). */
	textOnly?: boolean;
	/** Perfil del usuario para personalizar respuestas (nombre, idioma, sobre ti). */
	userProfile?: UserProfileInput | null;
	/** Rol operativo actual del agente. */
	role?: Role;
};

/** Prioridad: SOUL > perfil > workspace > skills > tools > memoria > mensaje del usuario. */
export function buildContext(input: ContextInput): { system: string; messages: Message[] } {
	const approxCharsPerToken = 4;
	const budgetChars = Math.floor(input.tokenBudget * approxCharsPerToken);

	const textOnly = input.textOnly === true;
	const soul = getSoulWithRole(input.agentName, input.role ?? "default", textOnly);
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
	const toolBlock = textOnly
		? ""
		: (() => {
				const toolsDef = getToolsDefinitionScoped(input.allowedTools);
				const toolsManifest =
					input.toolsManifest ??
					toolsDef.map((t) => t.function.name + ": " + (t.function.description ?? "")).join("; ");
				return `## Herramientas disponibles\n${toolsManifest}`;
			})();
	if (toolBlock) remaining -= toolBlock.length;

	const workspaceBlock = input.workspaceContext
		? `## Contexto workspace\n${input.workspaceContext.slice(0, Math.min(remaining, 4000))}`
		: "";
	if (workspaceBlock) remaining -= workspaceBlock.length;

	const skillsBlock = textOnly
		? ""
		: loadRelevantSkills(input.goal, Math.max(800, Math.min(remaining, 2500)));
	if (skillsBlock) remaining -= skillsBlock.length;

	// Conversación simple: menos contexto para mantener el prompt conciso
	const shortMaxChars = textOnly ? 400 : Math.min(remaining - 400, 2000);
	const recent = input.shortMemory.getRecent(textOnly ? 10 : 30);
	const shortBlock = eventsToContextLines(recent, shortMaxChars);
	remaining -= shortBlock.length;

	const long = input.shortMemory.getLongTerm();
	const longBlock =
		long && remaining > 100 && !textOnly
			? `## Memoria a largo plazo (resumen)\n${long.summary}`
			: "";

	const system =
		soul +
		safeNote +
		userBlock +
		(workspaceBlock ? "\n\n" + workspaceBlock : "") +
		(skillsBlock ? "\n\n" + skillsBlock : "") +
		(toolBlock ? "\n\n" + toolBlock : "") +
		(shortBlock ? "\n\n## Eventos recientes\n" + shortBlock : "") +
		(longBlock ? "\n\n" + longBlock : "");

	// Conversación simple: solo el mensaje del usuario. Modo acción: el goal tal cual.
	const userContent = input.goal;
	const messages: Message[] = [{ role: "user", content: userContent }];
	return { system, messages };
}
