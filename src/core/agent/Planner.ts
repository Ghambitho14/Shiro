import type { Message } from "./Types.js";
import type { LLMClient } from "../llm/LLMClient.js";
import { getSoul } from "../soul/soul.js";

const PLANNER_PROMPT = `Eres un planificador. Dado el objetivo del usuario, responde con una lista corta de pasos (1-5), uno por línea, sin numeración ni viñetas. Solo los pasos, nada más. Ejemplo:
Leer el archivo X
Resumir el contenido
Responder al usuario con el resumen`;

export async function plan(
	llm: LLMClient,
	goal: string,
	agentName: string,
): Promise<string[]> {
	const system = getSoul(agentName) + "\n\n" + PLANNER_PROMPT;
	const messages: Message[] = [
		{ role: "system", content: system },
		{ role: "user", content: `Objetivo: ${goal}\n\nLista de pasos (solo los pasos):` },
	];
	const raw = await llm.chat(messages);
	const lines = raw
		.split("\n")
		.map((s) => s.replace(/^[\s\-*\d.)]+/, "").trim())
		.filter((s) => s.length > 0);
	return lines.slice(0, 10);
}
