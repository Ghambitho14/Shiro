/**
 * Chats de Shiro. Esta parte decide título, resumen y limpieza de mensajes; dónde se guardan
 * (memoria, este equipo, Obsidian o Supabase) lo decide backends.ts según Ajustes → Datos.
 */
import { randomUUID } from "node:crypto";
import { getConfig } from "../config/config.js";
import { currentStorage } from "../storage/storage.js";
import { chatBackendFor, createMemoryBackend, type ChatBackend } from "./backends.js";
import type { ContentPart } from "../core/agent/Types.js";
import { getMessagePreview } from "../core/agent/contentUtils.js";

/** Herramienta usada en una respuesta (se muestra como "pasos" en la web). */
export type ChatToolUse = { name: string; label: string; ok: boolean; image?: string };

export type ChatMessage = {
	role: "user" | "assistant";
	/** Texto o, en mensajes de usuario, array de partes (texto + imagen) para visión. */
	content: string | ContentPart[];
	/** Hora del mensaje (ms). */
	ts?: number;
	tools?: ChatToolUse[];
	/** En una sala: id del agente que respondió (sin él, el asistente de siempre). */
	agent?: string;
	/** Su nombre en ese momento (se sigue viendo aunque luego se borre el agente). */
	agentName?: string;
};

export type ChatSessionMeta = {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	lastPreview: string;
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
function sanitizeMeta(item: Record<string, unknown>): Pick<ChatMessage, "ts" | "tools" | "agent" | "agentName"> {
	const out: Pick<ChatMessage, "ts" | "tools" | "agent" | "agentName"> = {};
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
				return { name, label, ok: r.ok !== false, ...(image ? { image } : {}) };
			})
			.filter((t): t is ChatToolUse => t !== null);
		if (tools.length) out.tools = tools;
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


// ───────────────────────────── almacén ─────────────────────────────

/** Si persistChatHistory es false, los chats viven solo en memoria (se pierden al cerrar Shiro). */
const memoryBackend = createMemoryBackend();

function backend(): ChatBackend {
	if (getConfig().persistChatHistory === false) return memoryBackend;
	return chatBackendFor(currentStorage(), sanitizeMessages);
}

export async function listChatSessions(): Promise<ChatSessionMeta[]> {
	return backend().list();
}

export async function createChatSession(initialMessages: ChatMessage[] = []): Promise<ChatSession> {
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
	return session;
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
	return backend().get(id);
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
	return { id, createdAt: existing.createdAt, ...patch };
}

export async function renameChatSession(id: string, title: string): Promise<ChatSession | null> {
	const trimmed = title.trim();
	if (!trimmed) return null;
	const store = backend();
	if (!(await store.update(id, { title: trimmed, updatedAt: Date.now() }))) return null;
	return store.get(id);
}

export async function deleteChatSession(id: string): Promise<boolean> {
	return backend().remove(id);
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
