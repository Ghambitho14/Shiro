/**
 * Chats de Shiro. Esta parte decide título, resumen y limpieza de mensajes; dónde se guardan
 * (memoria, este equipo, Obsidian o Supabase) lo decide backends.ts según Ajustes → Datos.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/config.js";
import { currentStorage } from "../storage/storage.js";
import { chatBackendFor, createMemoryBackend, type ChatBackend } from "./backends.js";
import type { ContentPart } from "../core/agent/Types.js";
import type { ResponseUsage } from "../core/llm/LLMClient.js";
import { sanitizeContextReport, type ContextReport } from "../core/agent/contextUsage.js";
import { getMessagePreview } from "../core/agent/contentUtils.js";
import { CHAT_MODES, type ChatMode } from "../core/agent/chatMode.js";
import { getChatMode, modeOfMessages, removeChatMode, setChatMode } from "./chatModes.js";
import type { TodoItem } from "../core/agent/previousWork.js";

/** Herramienta usada en una respuesta (se muestra como "pasos" en la web). */
export type ChatToolUse = { name: string; label: string; ok: boolean; image?: string; /** Id para deshacer el cambio de archivo de este paso. */ undo?: string; /** El usuario ya lo deshizo. */ undone?: boolean };

export type ChatMessage = {
	role: "user" | "assistant";
	/** Texto o, en mensajes de usuario, array de partes (texto + imagen) para visión. */
	content: string | ContentPart[];
	/** Hora del mensaje (ms). */
	ts?: number;
	tools?: ChatToolUse[];
	/** Respuestas del asistente: la lista de tareas que llevaba (tool `todo`), como quedó al terminar. */
	todo?: TodoItem[];
	/** En una sala: id del agente que respondió (sin él, el asistente de siempre). */
	agent?: string;
	/** Su nombre en ese momento (se sigue viendo aunque luego se borre el agente). */
	agentName?: string;
	/** Respuestas del asistente: tokens que gastó (leídos, escritos, pensando y vueltas con el modelo). */
	usage?: ResponseUsage;
	/** Respuestas del asistente: cuánto contexto del modelo ocupó y en qué (medidor de la web). */
	context?: ContextReport;
	/** En mensajes del usuario: modo usado; al abrir el chat se recupera el del último. */
	mode?: ChatMode;
	/**
	 * Resumen de «Cerrar conversación» (closeChat.ts). Lo anterior se sigue guardando y viendo, pero al
	 * modelo solo le llegan este resumen y lo que viene después (`compactConversation`).
	 */
	summary?: true;
};

export type ChatSessionMeta = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	lastPreview: string;
	/** Modo del chat (cada modo tiene su lista en la web). No lo guardan los almacenamientos: va en chatModes.ts. */
	mode?: ChatMode;
};

export type ChatSession = ChatSessionMeta & {
	messages: ChatMessage[];
};

function computeTitle(messages: ChatMessage[], fallback = "Nueva sesión"): string {
	const firstUser = messages.find((m) => m.role === "user" && getMessagePreview(m.content).length > 0);
	if (!firstUser) return fallback;
	const normalized = getMessagePreview(firstUser.content).replace(/\s+/g, " ");
	if (normalized.length <= 40) return normalized;
	return normalized.slice(0, 40) + "...";
}

function computeLastPreview(messages: ChatMessage[]): string {
	const last = [...messages].reverse().find((m) => getMessagePreview(m.content).length > 0);
	if (!last) return "";
	const normalized = getMessagePreview(last.content).replace(/\s+/g, " ");
	if (normalized.length <= 80) return normalized;
	return normalized.slice(0, 80) + "...";
}

function isContentPartArray(raw: unknown): raw is ContentPart[] {
	if (!Array.isArray(raw)) return false;
	return raw.every((p) => {
		if (!p || typeof p !== "object") return false;
		const type = (p as { type?: unknown }).type;
		if (type === "text") return typeof (p as { text?: unknown }).text === "string";
		if (type === "image_url") {
			const iu = (p as { image_url?: unknown }).image_url;
			return iu && typeof iu === "object" && typeof (iu as { url?: unknown }).url === "string";
		}
		return false;
	});
}

/** Datos extra de cada mensaje que guarda la web: hora, herramientas usadas y, en salas, qué agente habló. */
function sanitizeMeta(item: Record<string, unknown>): Pick<ChatMessage, "ts" | "tools" | "todo" | "agent" | "agentName" | "usage" | "context" | "mode" | "summary"> {
	const out: Pick<ChatMessage, "ts" | "tools" | "todo" | "agent" | "agentName" | "usage" | "context" | "mode" | "summary"> = {};
	if (item.role === "assistant" && item.summary === true) out.summary = true;
	if (item.role === "user" && typeof item.mode === "string") {
		if ((CHAT_MODES as readonly string[]).includes(item.mode)) out.mode = item.mode as ChatMode;
	}
	if (item.role === "assistant" && item.usage && typeof item.usage === "object") {
		const u = item.usage as Record<string, unknown>;
		const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e9) : 0);
		const usage = { input: n(u.input), output: n(u.output), reasoning: n(u.reasoning), turns: n(u.turns) };
		if (usage.turns) out.usage = usage;
	}
	if (item.role === "assistant") {
		const context = sanitizeContextReport(item.context);
		if (context) out.context = context;
	}
	if (typeof item.ts === "number" && Number.isFinite(item.ts)) out.ts = item.ts;
	if (item.role === "assistant" && typeof item.agent === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(item.agent)) {
		out.agent = item.agent;
		const name = typeof item.agentName === "string" ? item.agentName.trim().slice(0, 40) : "";
		if (name) out.agentName = name;
	}
	if (Array.isArray(item.tools)) {
		const tools = item.tools
			.slice(0, 30)
			.map((t): ChatToolUse | null => {
				if (!t || typeof t !== "object") return null;
				const r = t as Record<string, unknown>;
				const name = String(r.name ?? "").slice(0, 60);
				const label = String(r.label ?? "").slice(0, 200);
				if (!name && !label) return null;
				const image = typeof r.image === "string" && /^\/api\/screenshots\/[\w.%-]+$/.test(r.image) ? r.image : undefined;
				const undo = typeof r.undo === "string" && /^[0-9a-f-]{36}$/.test(r.undo) ? r.undo : undefined;
				return { name, label, ok: r.ok !== false, ...(image ? { image } : {}), ...(undo ? { undo } : {}), ...(r.undone === true ? { undone: true } : {}) };
			})
			.filter((t): t is ChatToolUse => t !== null);
		if (tools.length) out.tools = tools;
	}
	if (item.role === "assistant" && Array.isArray(item.todo)) {
		const todo = item.todo
			.slice(0, 20)
			.map((t): TodoItem | null => {
				if (!t || typeof t !== "object") return null;
				const r = t as Record<string, unknown>;
				const text = String(r.text ?? "").trim().slice(0, 200);
				if (!text) return null;
				return { text, status: r.status === "done" || r.status === "in_progress" ? r.status : "pending" };
			})
			.filter((t): t is TodoItem => t !== null);
		if (todo.length) out.todo = todo;
	}
	return out;
}

export function sanitizeMessages(input: unknown): ChatMessage[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const role = (item as { role?: unknown }).role;
			const content = (item as { content?: unknown }).content;
			if (role !== "user" && role !== "assistant") return null;
			const meta = sanitizeMeta(item as Record<string, unknown>);
			if (typeof content === "string") {
				const trimmed = content.trim();
				if (!trimmed) return null;
				return { role, content: trimmed, ...meta } as ChatMessage;
			}
			if (isContentPartArray(content)) {
				const hasText = content.some((p) => (p as ContentPart).type === "text" && String((p as { text?: string }).text).trim());
				const hasImage = content.some((p) => (p as ContentPart).type === "image_url");
				if (!hasText && !hasImage) return null;
				return { role, content, ...meta } as ChatMessage;
			}
			return null;
		})
		.filter((m): m is ChatMessage => m !== null);
}

/**
 * Lo que el modelo ve de un chat cerrado con «Cerrar conversación»: el último resumen (aparte: va en
 * el system prompt) y los mensajes de después. Sin resumen, el chat entero.
 */
export function compactConversation<T extends { summary?: true; content: string | ContentPart[] }>(messages: T[]): { summary?: string; messages: T[] } {
	let i = messages.length - 1;
	while (i >= 0 && !messages[i].summary) i--;
	if (i < 0) return { messages };
	return { summary: getMessagePreview(messages[i].content), messages: messages.slice(i + 1) };
}

// ───────────────────────────── almacén ─────────────────────────────

/** Si persistChatHistory es false, los chats viven solo en memoria (se pierden al cerrar Shiro). */
const memoryBackend = createMemoryBackend();

function backend(): ChatBackend {
	if (getConfig().persistChatHistory === false) return memoryBackend;
	return chatBackendFor(currentStorage(), sanitizeMessages);
}

/**
 * Los chats con su modo. Los que aún no lo tienen anotado (chats de antes, o de WhatsApp, Telegram o el móvil)
 * se clasifican una vez por sus mensajes; sin mensajes del usuario se quedan en Chat sin anotar.
 */
export async function listChatSessions(): Promise<ChatSessionMeta[]> {
	const store = backend();
	const sessions = await store.list();
	const out: ChatSessionMeta[] = [];
	for (const s of sessions) {
		let mode = getChatMode(s.id);
		if (!mode) {
			const full = await store.get(s.id).catch(() => null);
			const messages = full?.messages ?? [];
			mode = modeOfMessages(messages) ?? (messages.some((m) => m.role === "user") ? "chat" : undefined);
			if (mode) setChatMode(s.id, mode);
		}
		out.push({ ...s, mode: mode ?? "chat" });
	}
	return out;
}

export async function createChatSession(initialMessages: ChatMessage[] = [], mode?: ChatMode): Promise<ChatSession> {
	const now = Date.now();
	const messages = sanitizeMessages(initialMessages);
	const session: ChatSession = {
		id: randomUUID(),
		title: computeTitle(messages),
		createdAt: now,
		updatedAt: now,
		lastPreview: computeLastPreview(messages),
		messages,
	};
	await backend().insert(session);
	const chosen = mode ?? modeOfMessages(messages);
	if (chosen) setChatMode(session.id, chosen);
	return { ...session, mode: chosen ?? "chat" };
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
	const session = await backend().get(id);
	if (!session) return null;
	return { ...session, mode: getChatMode(id) ?? modeOfMessages(session.messages) ?? "chat" };
}

export async function saveChatSession(id: string, messages: ChatMessage[]): Promise<ChatSession | null> {
	const store = backend();
	const existing = await store.meta(id);
	if (!existing) return null;
	const cleanMessages = sanitizeMessages(messages);
	const patch = {
		title: computeTitle(cleanMessages) || existing.title || "Nueva sesión",
		updatedAt: Date.now(),
		lastPreview: computeLastPreview(cleanMessages),
		messages: cleanMessages,
	};
	if (!(await store.update(id, patch))) return null;
	// Un chat sin modo anotado lo toma de su primer mensaje con modo (la web no mezcla modos en un chat).
	let mode = getChatMode(id);
	if (!mode) {
		mode = modeOfMessages(cleanMessages);
		if (mode) setChatMode(id, mode);
	}
	return { id, createdAt: existing.createdAt, ...patch, mode: mode ?? "chat" };
}

export async function renameChatSession(id: string, title: string): Promise<ChatSession | null> {
	const trimmed = title.trim();
	if (!trimmed) return null;
	const store = backend();
	if (!(await store.update(id, { title: trimmed, updatedAt: Date.now() }))) return null;
	return store.get(id);
}

export async function deleteChatSession(id: string): Promise<boolean> {
	const ok = await backend().remove(id);
	if (ok) removeChatMode(id);
	return ok;
}

export async function getOrCreateLinkedChatSession(channel: string, externalId: string, titleHint?: string): Promise<ChatSession> {
	const cleanChannel = channel.trim();
	const cleanExternalId = externalId.trim();
	if (!cleanChannel || !cleanExternalId) {
		throw new Error("channel y externalId son requeridos");
	}
	const store = backend();
	const linkedId = await store.findLink(cleanChannel, cleanExternalId);
	if (linkedId) {
		const existing = await store.get(linkedId);
		if (existing) return existing;
	}
	const created = await createChatSession();
	if (titleHint?.trim()) {
		created.title = titleHint.trim();
		await store.update(created.id, { title: created.title });
	}
	await store.setLink(cleanChannel, cleanExternalId, created.id);
	return created;
}
