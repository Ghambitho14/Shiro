/**
 * Respuestas del chat web que siguen aunque se corte la conexión.
 *
 * Salir de la página, cambiar de app en el móvil o abrir otro chat corta la conexión con el navegador,
 * pero Aku termina igual la respuesta y la guarda siempre él mismo en el chat (`appendDetachedReply`). Solo el
 * botón «Detener» la cancela, con `stopRun` (POST /api/chat/stop). La web pregunta por `listRuns` si un
 * chat sigue respondiendo para esperarlo y recargarlo.
 *
 * Retomar: mientras responde, lo que lleva (pasos, lista de tareas y el texto) se apunta en
 * `data/cache/active-runs.json`. Si Aku se cierra a mitad, al volver a abrirse `recoverInterruptedRuns`
 * deja eso en el chat como una respuesta `interrupted` (la web la enseña con el botón «Continuar»), y la
 * nota «Lo que hiciste en tu respuesta anterior» (previousWork.ts) le dice al modelo por dónde iba.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config/config.js";
import type { ToolEvent } from "../core/agent/Agent.js";
import type { TodoItem } from "../core/agent/previousWork.js";
import { getChatSession, saveChatSession, type ChatMessage, type ChatToolUse } from "./ChatStore.js";

type Run = { id: string; sessionId?: string; abort: AbortController; startedAt: number };

/** Lo que se apunta en disco de una respuesta en marcha. */
type ActiveRecord = { sessionId: string; startedAt: number; tools: ChatToolUse[]; todo?: TodoItem[]; text: string; agent?: string; agentName?: string };

const runs = new Map<string, Run>();
const active = new Map<string, ActiveRecord>();
/** Texto que se guarda de una respuesta interrumpida (lo último que escribió). */
const MAX_PARTIAL_TEXT = 4000;

const activeFile = () => join(DATA_DIR, "cache", "active-runs.json");
let persistTimer: NodeJS.Timeout | undefined;

function writeActive(): void {
	try {
		if (!active.size) {
			rmSync(activeFile(), { force: true });
			return;
		}
		mkdirSync(join(DATA_DIR, "cache"), { recursive: true });
		writeFileSync(activeFile(), JSON.stringify([...active.values()]), "utf-8");
	} catch {
		/* sin disco no se puede retomar, pero la respuesta sigue */
	}
}

/** Escribe como mucho cada segundo (el texto llega a trozos muy seguidos). */
function persistSoon(): void {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		writeActive();
	}, 1000);
	persistTimer.unref?.();
}

export function startRun(sessionId: string | undefined, who?: { agent?: string; agentName?: string }): Run {
	const run: Run = { id: randomUUID(), sessionId, abort: new AbortController(), startedAt: Date.now() };
	runs.set(run.id, run);
	if (sessionId) {
		active.set(run.id, { sessionId, startedAt: run.startedAt, tools: [], text: "", ...(who?.agent ? { agent: who.agent, agentName: who.agentName } : {}) });
		writeActive();
	}
	return run;
}

export function finishRun(id: string): void {
	runs.delete(id);
	if (active.delete(id)) writeActive();
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

/**
 * Va juntando los pasos y la lista de tareas de la respuesta, por si hay que guardarla sin la web.
 * Con `runId`, además lo apunta en disco para poder retomarla si Aku se cierra.
 */
export function createReplyRecorder(runId?: string) {
	const tools: (ChatToolUse & { id: string })[] = [];
	let todo: TodoItem[] | undefined;
	let text = "";
	const sync = () => {
		const rec = runId ? active.get(runId) : undefined;
		if (!rec) return;
		rec.tools = tools.map(({ id: _id, ...t }) => t);
		rec.todo = todo;
		rec.text = text.length > MAX_PARTIAL_TEXT ? "…" + text.slice(-MAX_PARTIAL_TEXT) : text;
		persistSoon();
	};
	return {
		tool(e: ToolEvent, image?: string) {
			if (e.phase === "start") {
				tools.push({ id: e.id, name: e.name, label: e.label, ok: true });
				sync();
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
			sync();
		},
		todo(items: TodoItem[]) {
			todo = items;
			sync();
		},
		text(chunk: string) {
			text += chunk;
			sync();
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

/** El mensaje que queda en el chat cuando Aku se cerró a mitad de una respuesta. */
export function interruptedReply(rec: ActiveRecord): ChatMessage {
	const done = rec.todo?.filter((t) => t.status === "done").length ?? 0;
	const total = rec.todo?.length ?? 0;
	const progress = total ? ` Iba en ${done} de ${total} tareas.` : rec.tools.length ? ` Alcanzó a dar ${rec.tools.length} paso(s).` : "";
	const partial = rec.text.trim();
	return {
		role: "assistant",
		content: `${partial ? partial + "\n\n" : ""}⚠️ Aku se cerró antes de terminar esta respuesta.${progress} Pulsa «Continuar» para que siga donde quedó.`,
		ts: Date.now(),
		interrupted: true,
		...(rec.tools.length ? { tools: rec.tools.slice(0, 30) } : {}),
		...(rec.todo?.length ? { todo: rec.todo } : {}),
		...(rec.agent ? { agent: rec.agent, agentName: rec.agentName } : {}),
	};
}

/**
 * Al arrancar: las respuestas que quedaron a medias (Aku se cerró, se colgó o se apagó el PC) se dejan en su chat
 * como respuesta interrumpida. Se llama una vez, antes de empezar respuestas nuevas. Devuelve cuántas recuperó.
 */
export async function recoverInterruptedRuns(): Promise<number> {
	if (!existsSync(activeFile())) return 0;
	let records: ActiveRecord[] = [];
	try {
		const data = JSON.parse(readFileSync(activeFile(), "utf-8")) as unknown;
		if (Array.isArray(data)) records = data.filter((r): r is ActiveRecord => !!r && typeof r.sessionId === "string" && Array.isArray(r.tools));
	} catch {
		/* archivo cortado: no hay nada que retomar */
	}
	rmSync(activeFile(), { force: true });
	let recovered = 0;
	for (const rec of records) {
		// Una respuesta sin pasos ni texto no dejó nada: basta con volver a preguntar.
		if (!rec.tools.length && !rec.text.trim() && !rec.todo?.length) continue;
		if (await appendDetachedReply(rec.sessionId, interruptedReply(rec)).catch(() => false)) recovered++;
	}
	return recovered;
}
