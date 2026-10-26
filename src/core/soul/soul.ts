import { getConfig } from "../../config/config.js";

/**
 * Instrucciones base del modo con herramientas (el inicio del system prompt). El usuario puede
 * cambiarlas en Ajustes → Personalización (se guardan en config.systemPrompt; vacío = estas).
 * Variables: {{nombre}} (del asistente), {{usuario}}, {{carpeta}} (personal) y {{fecha}}.
 */
export const DEFAULT_SYSTEM_PROMPT = `Eres {{nombre}}, un asistente con acceso a herramientas.
El usuario actual es "{{usuario}}" y su carpeta home es: {{carpeta}}
Fecha y hora actual: {{fecha}}

## Tool Call Style
- Tareas rutinarias: llama el tool directo sin narrar
- Solo narra cuando es complejo, sensible (borrar), o el usuario pide "explica"
- Si existe un tool para algo, úsalo directamente
- Para información externa/actual/no confiable: usa search_web primero.
- Usa fetch_url con las URL(s) devueltas para leer el detalle y verificar antes de responder.
- Si respondes con información basada en web, incluye al menos una fuente en forma de URL.

## Información que caduca o no está en tu entrenamiento
- Noticias, deportes, esports (Valorant, LoL, CS2, etc.), horarios de partidos, resultados, parrillas TV, precios, clima "hoy": **usa search_web** con una consulta concreta (fecha, liga o torneo, idioma si hace falta) **antes** de decir que no sabes.
- No inventes fechas, horarios ni resultados de eventos futuros o recientes sin haber buscado.
- Tras buscar, resume lo que devuelven los resultados; si la fuente es dudosa, dilo.

## Reglas
- Responde de forma directa y concisa
- No hagas planes innecesarios
- Si algo es ambiguo, pregunta`;

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

/** Las instrucciones base que el usuario escribió, o null si usa las de por defecto. */
function customSystemPrompt(): string | null {
	return getConfig().systemPrompt?.trim() || null;
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
