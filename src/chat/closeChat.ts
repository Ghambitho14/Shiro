/**
 * «Cerrar conversación» (botón junto a «Hablar con un agente»): el modelo resume lo hablado desde el
 * último cierre, el resumen se guarda como recuerdo (`memory_search` lo encuentra desde cualquier chat) y
 * se añade al chat como mensaje `summary`. El chat sigue completo para leerlo, pero desde ahí al modelo
 * solo le llegan el resumen y lo nuevo (`compactConversation`): como el /compact de Claude Code.
 */
import { getState } from "../store.js";
import { getLLM } from "../core/llm/getLLM.js";
import type { LLMClient } from "../core/llm/LLMClient.js";
import type { Message } from "../core/agent/Types.js";
import { getMessagePreview } from "../core/agent/contentUtils.js";
import { addMemory } from "../core/memory/memories.js";
import { compactConversation, getChatSession, saveChatSession, type ChatMessage, type ChatSession } from "./ChatStore.js";

/** Lo que se le manda al modelo para resumir: los últimos mensajes que quepan. */
const TRANSCRIPT_MAX_CHARS = 40_000;
const MESSAGE_MAX_CHARS = 3_000;

export class CloseChatError extends Error {}

/** La conversación como texto («Usuario: …» / «Aku: …»), recortada por el principio si es muy larga. */
export function transcriptOf(messages: ChatMessage[], assistantName: string): string {
	const lines = messages
		.map((m) => {
			const text = getMessagePreview(m.content).trim();
			if (!text) return "";
			const who = m.role === "user" ? "Usuario" : m.agentName || assistantName;
			return `${who}: ${text.length > MESSAGE_MAX_CHARS ? text.slice(0, MESSAGE_MAX_CHARS) + "…" : text}`;
		})
		.filter(Boolean);
	const out: string[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (used + lines[i].length > TRANSCRIPT_MAX_CHARS && out.length) break;
		out.unshift(lines[i]);
		used += lines[i].length + 2;
	}
	return (out.length < lines.length ? "(…los primeros mensajes no caben)\n\n" : "") + out.join("\n\n");
}

export function summaryPrompt(transcript: string, previous: string | undefined, assistantName: string): Message[] {
	return [
		{
			role: "system",
			content: `Resumes conversaciones entre el usuario y ${assistantName}, su asistente, para que ${assistantName} las recuerde después. Escribe en español, en viñetas cortas y sin saludos:
- De qué se habló.
- Qué se hizo o se decidió, con los datos concretos que sirvan después (nombres, cifras, archivos, enlaces).
- Lo que se supo del usuario o de sus preferencias.
- Lo que quedó pendiente.
Como mucho 250 palabras. Nunca copies contraseñas, claves, tokens ni otros secretos: di solo que existían. No inventes nada que no esté en la conversación.`,
		},
		{
			role: "user",
			content: `${previous ? `Resumen de lo que ya se había cerrado antes en este chat (júntalo con lo nuevo):\n${previous}\n\n` : ""}Conversación:\n\n${transcript}\n\nEscribe el resumen.`,
		},
	];
}

/** Resume el chat, guarda el resumen como recuerdo y lo añade al chat. Devuelve el chat guardado. */
export async function closeChatSession(id: string, llm: LLMClient = getLLM()): Promise<ChatSession | null> {
	const session = await getChatSession(id);
	if (!session) return null;
	const { summary: previous, messages } = compactConversation(session.messages);
	if (!messages.some((m) => m.role === "user")) throw new CloseChatError("No hay nada nuevo que resumir desde el último cierre.");
	const name = getState().name || "Aku";
	const raw = await llm.chat(summaryPrompt(transcriptOf(messages, name), previous, name), { sessionId: id, thinking: "off" });
	// Sin lo que pensó (sanitizeModelResponse devolvería el texto tal cual si solo hay <think>).
	const summary = raw
		.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
		.trim();
	if (!summary) throw new CloseChatError("El modelo no devolvió ningún resumen. Prueba otra vez.");
	const date = new Date().toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" });
	await addMemory({ content: `Resumen del chat «${session.title}» (${date}):\n${summary}`, type: "conversation", tags: ["resumen", "chat"] });
	return saveChatSession(id, [...session.messages, { role: "assistant", content: summary, ts: Date.now(), summary: true }]);
}
