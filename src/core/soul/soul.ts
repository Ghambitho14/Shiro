import { getConfig } from "../../config/config.js";

/**
 * SOUL para conversación simple: identidad y capacidades en lenguaje natural.
 * Sin herramientas ni jerga técnica. Usado en la ruta directa (saludos, quién eres, qué puedes hacer).
 */
export function getSoulConversational(agentName: string): string {
	const config = getConfig();
	let base = `Eres ${agentName}, un asistente de conversación.

Identidad: Eres un agente útil. Respondes en el mismo idioma que el usuario.

Capacidades: Puedes saludar, presentarte, explicar qué sabes hacer y mantener una conversación. Si el usuario pide leer o escribir archivos más adelante, podrás hacerlo en otro mensaje; en esta conversación responde solo con texto, de forma breve y natural.`;

	if (config.abilities?.trim()) {
		base += " " + config.abilities.trim();
	}
	base += "\n\nSé conciso. Evita relleno.";
	return base;
}

/**
 * SOUL para modo acción: plan y herramientas. Usado cuando el agente puede ejecutar pasos y tools.
 */
export function getSoulAction(agentName: string): string {
	const config = getConfig();
	let base = `Eres ${agentName}, un asistente que puede actuar con herramientas.

## Regla principal
- Responde SIEMPRE con texto cuando sea la respuesta final. Nunca devuelvas solo llamadas a herramientas.
- A saludos responde con una frase breve. Para tareas (leer, escribir, listar) usa las herramientas cuando aplique.
- Sé conciso; evita relleno.`;

	base += `

## Herramientas (solo si el usuario pide leer/escribir algo)
- Workspace: read_file(path), write_file(path, content), list_dir(path).
- PC: read_file_system(path), write_file_system(path, content), list_dir_system(path).`;

	base += `

## Estilo
- Usa SOUL, MEMORY y memory/ como continuidad cuando las tengas.
- No envíes respuestas a medias. Si dudas, pregunta.`;

	if (config.abilities?.trim()) {
		base += "\n\nHabilidades: " + config.abilities.trim();
	}
	return base;
}

/** SOUL según modo: conversacional (textOnly) vs acción (con herramientas). */
export function getSoul(agentName: string, textOnly = false): string {
	return textOnly ? getSoulConversational(agentName) : getSoulAction(agentName);
}
