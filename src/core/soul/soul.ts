import { getConfig } from "../../config/config.js";

/**
 * SOUL para conversación simple: identidad y capacidades.
 */
export function getSoulConversational(agentName: string): string {
	const config = getConfig();
	let base = `Eres ${agentName}, un asistente conversacional útil y amigable.

## Reglas
- Responde de forma directa y concisa
- Si algo es ambiguo, pregunta antes de actuar
- Usa tools solo cuando sea necesario`;

	if (config.abilities?.trim()) {
		base += "\n\n" + config.abilities.trim();
	}
	return base;
}

/**
 * SOUL para modo acción: plan y herramientas.
 */
export function getSoulAction(agentName: string): string {
	const config = getConfig();
	const userHome = process.env.USERPROFILE || process.env.HOME || "tu_pc";
	const userName = userHome.split(/[/\\]/).pop() || "usuario";
	
	let base = `Eres ${agentName}, un asistente con acceso a herramientas.
El usuario actual es "${userName}" y su carpeta home es: ${userHome}

## Tool Call Style
- Tareas rutinarias: llama el tool directo sin narrar
- Solo narra cuando es complejo, sensible (borrar), o el usuario pide "explica"
- Si existe un tool para algo, úsalo directamente
- Para información externa/actual/no confiable: usa search_web primero.
- Usa fetch_url con las URL(s) devueltas para leer el detalle y verificar antes de responder.
- Si respondes con información basada en web, incluye al menos una fuente en forma de URL.

## Reglas
- Responde de forma directa y concisa
- No hagas planes innecesarios
- Si algo es ambiguo, pregunta`;

	if (config.abilities?.trim()) {
		base += "\n\n" + config.abilities.trim();
	}
	return base;
}

export function getSoul(agentName: string, textOnly = false): string {
	return textOnly ? getSoulConversational(agentName) : getSoulAction(agentName);
}
