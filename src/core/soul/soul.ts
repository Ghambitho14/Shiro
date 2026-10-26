import { getConfig } from "../../config/config.js";
import { readInstructions } from "../../workspace.js";
import { DEFAULT_SYSTEM_PROMPT } from "./defaultPrompt.js";

export { DEFAULT_SYSTEM_PROMPT };

/** Sustituye las variables de las instrucciones base. */
export function renderSystemPrompt(template: string, agentName: string): string {
	const userHome = process.env.USERPROFILE || process.env.HOME || "tu_pc";
	const vars: Record<string, string> = {
		nombre: agentName,
		usuario: userHome.split(/[/\\]/).pop() || "usuario",
		carpeta: userHome,
		fecha: new Date().toLocaleString("es", { dateStyle: "full", timeStyle: "short" }),
	};
	return template.replace(/\{\{\s*(nombre|usuario|carpeta|fecha)\s*\}\}/gi, (_, key: string) => vars[key.toLowerCase()]!);
}

/** Las instrucciones base que el usuario escribió (nota Instrucciones.md), o null si usa las de por defecto. */
function customSystemPrompt(): string | null {
	return readInstructions();
}

export function withAbilities(base: string): string {
	const abilities = getConfig().abilities?.trim();
	return abilities ? `${base}\n\n${abilities}` : base;
}

/**
 * SOUL para conversación simple: identidad y capacidades.
 */
export function getSoulConversational(agentName: string): string {
	const custom = customSystemPrompt();
	if (custom) return withAbilities(renderSystemPrompt(custom, agentName));
	return withAbilities(`Eres ${agentName}, un asistente conversacional útil y amigable.

## Reglas
- Responde de forma directa y concisa
- Si algo es ambiguo, pregunta antes de actuar
- Usa tools solo cuando sea necesario
- En este modo (solo texto) no tienes internet: si piden noticias, partidos, horarios o datos del día, explica que necesitan el modo con herramientas (autónomo) para poder buscar`);
}

/**
 * SOUL para modo acción: plan y herramientas.
 */
export function getSoulAction(agentName: string): string {
	return withAbilities(renderSystemPrompt(customSystemPrompt() ?? DEFAULT_SYSTEM_PROMPT, agentName));
}

export function getSoul(agentName: string, textOnly = false): string {
	return textOnly ? getSoulConversational(agentName) : getSoulAction(agentName);
}
