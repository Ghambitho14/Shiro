/**
 * Respuestas del chat web que siguen aunque se corte la conexión.
 *
 * Salir de la página, cambiar de app en el móvil o abrir otro chat corta la conexión con el navegador,
 * pero Aku termina igual la respuesta y la guarda siempre él mismo en el chat (`appendDetachedReply`). Solo el
 * botón «Detener» la cancela, con `stopRun` (POST /api/chat/stop). La web pregunta por `listRuns` si un
 * chat sigue respondiendo para esperarlo y recargarlo.
 */
import { randomUUID } from "node:crypto";
import type { ToolEvent } from "../core/agent/Agent.js";
import type { TodoItem } from "../core/agent/previousWork.js";
import { getChatSession, saveChatSession, type ChatMessage, type ChatToolUse } from "./ChatStore.js";

type Run = { id: string; sessionId?: string; abort: AbortController; startedAt: number };

const runs = new Map<string, Run>();

export function startRun(sessionId: string | undefined): Run {
	const run: Run = { id: randomUUID(), sessionId, abort: new AbortController(), startedAt: Date.now() };
	runs.set(run.id, run);
	return run;
}

export function finishRun(id: string): void {
	runs.delete(id);
}

/** «Detener»: cancela el modelo y las herramientas pendientes. Devuelve false si ya no estaba. */
export function stopRun(id: string): boolean {
	const run = runs.get(id);
	if (!run) return false;
	run.abort.abort();
	return true;
}

/** Respuestas en marcha (de chats guardados), para que la web sepa qué chat sigue respondiendo. */
export function listRuns(): { runId: string; sessionId: string; startedAt: number }[] {
	return [...runs.values()]
		.filter((r): r is Run & { sessionId: string } => typeof r.sessionId === "string" && !r.abort.signal.aborted)
		.map((r) => ({ runId: r.id, sessionId: r.sessionId, startedAt: r.startedAt }));
}

/** Va juntando los pasos y la lista de tareas de la respuesta, por si hay que guardarla sin la web. */
export function createReplyRecorder() {
	const tools: (ChatToolUse & { id: string })[] = [];
	let todo: TodoItem[] | undefined;
	return {
		tool(e: ToolEvent, image?: string) {
			if (e.phase === "start") {
				tools.push({ id: e.id, name: e.name, label: e.label, ok: true });
				return;
			}
			const t = tools.find((x) => x.id === e.id);
			if (!t) return;
			t.ok = e.ok;
			if (image) t.image = image;
			if (e.phase === "end" && e.ok) {
				if (e.undo) t.undo = e.undo;
				if (e.drawing) t.drawing = e.drawing;
			}
		},
		todo(items: TodoItem[]) {
			todo = items;
		},
		parts(): Pick<ChatMessage, "tools" | "todo"> {
			return {
				...(tools.length ? { tools: tools.map(({ id: _id, ...t }) => t) } : {}),
				...(todo?.length ? { todo } : {}),
			};
		},
	};
}

/**
 * Guarda al final del chat la respuesta terminada (haya o no alguien conectado; si la web sigue ahí, su PUT la reemplaza igual).
 * Lee el chat en ese momento (no el de cuando empezó) para no pisar lo que se guardó mientras tanto.
 */
export async function appendDetachedReply(sessionId: string, reply: ChatMessage): Promise<boolean> {
	const session = await getChatSession(sessionId);
	if (!session) return false;
	const saved = await saveChatSession(sessionId, [...session.messages, reply]);
	return saved !== null;
}
