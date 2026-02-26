import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DATA_DIR } from "../config/config.js";

export type ChatMessage = {
	role: "user" | "assistant";
	content: string;
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

const CHAT_DIR = join(DATA_DIR, "chats");
const DB_FILE = join(DATA_DIR, "chat-index.sqlite");

type SessionRow = {
	id: string;
	title: string;
	file_path: string;
	created_at: number;
	updated_at: number;
	last_preview: string | null;
};

type LinkRow = {
	session_id: string;
};

let db: Database.Database | null = null;

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function getDb(): Database.Database {
	if (db) return db;
	ensureDir(DATA_DIR);
	ensureDir(CHAT_DIR);
	db = new Database(DB_FILE);
	db.pragma("foreign_keys = ON");
	db.pragma("journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS chat_sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			file_path TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_preview TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC);
		CREATE TABLE IF NOT EXISTS chat_session_links (
			channel TEXT NOT NULL,
			external_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			PRIMARY KEY (channel, external_id),
			FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
		);
		CREATE INDEX IF NOT EXISTS idx_chat_session_links_session_id ON chat_session_links(session_id);
	`);
	return db;
}

function buildChatFilePath(id: string): string {
	return join(CHAT_DIR, `${id}.json`);
}

function computeTitle(messages: ChatMessage[], fallback = "Nueva sesion"): string {
	const firstUser = messages.find((m) => m.role === "user" && m.content.trim().length > 0);
	if (!firstUser) return fallback;
	const normalized = firstUser.content.trim().replace(/\s+/g, " ");
	if (normalized.length <= 40) return normalized;
	return normalized.slice(0, 40) + "...";
}

function computeLastPreview(messages: ChatMessage[]): string {
	const last = [...messages].reverse().find((m) => m.content.trim().length > 0);
	if (!last) return "";
	const normalized = last.content.trim().replace(/\s+/g, " ");
	if (normalized.length <= 80) return normalized;
	return normalized.slice(0, 80) + "...";
}

function sanitizeMessages(input: unknown): ChatMessage[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const role = (item as { role?: unknown }).role;
			const content = (item as { content?: unknown }).content;
			if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
			const trimmed = content.trim();
			if (!trimmed) return null;
			return { role, content: trimmed } as ChatMessage;
		})
		.filter((m): m is ChatMessage => m !== null);
}

function rowToMeta(row: SessionRow): ChatSessionMeta {
	return {
		id: row.id,
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastPreview: row.last_preview ?? "",
	};
}

function setSessionTitle(sqlite: Database.Database, id: string, title: string): void {
	const trimmed = title.trim();
	if (!trimmed) return;
	sqlite.prepare(`
		UPDATE chat_sessions
		SET title = @title
		WHERE id = @id
	`).run({
		id,
		title: trimmed,
	});
}

function writeSessionFile(id: string, messages: ChatMessage[]): void {
	ensureDir(CHAT_DIR);
	const filePath = buildChatFilePath(id);
	writeFileSync(filePath, JSON.stringify({ id, messages }, null, 2), "utf-8");
}

function readSessionFile(id: string): ChatMessage[] {
	const filePath = buildChatFilePath(id);
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { messages?: unknown };
		return sanitizeMessages(parsed.messages);
	} catch {
		return [];
	}
}

export function listChatSessions(): ChatSessionMeta[] {
	const sqlite = getDb();
	const rows = sqlite.prepare("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions ORDER BY updated_at DESC").all() as SessionRow[];
	return rows.map(rowToMeta);
}

export function createChatSession(initialMessages: ChatMessage[] = []): ChatSession {
	const sqlite = getDb();
	const now = Date.now();
	const id = randomUUID();
	const cleanMessages = sanitizeMessages(initialMessages);
	const title = computeTitle(cleanMessages);
	const lastPreview = computeLastPreview(cleanMessages);
	const filePath = buildChatFilePath(id);

	writeSessionFile(id, cleanMessages);

	sqlite.prepare(`
		INSERT INTO chat_sessions (id, title, file_path, created_at, updated_at, last_preview)
		VALUES (@id, @title, @filePath, @createdAt, @updatedAt, @lastPreview)
	`).run({
		id,
		title,
		filePath,
		createdAt: now,
		updatedAt: now,
		lastPreview,
	});

	return {
		id,
		title,
		createdAt: now,
		updatedAt: now,
		lastPreview,
		messages: cleanMessages,
	};
}

export function getChatSession(id: string): ChatSession | null {
	const sqlite = getDb();
	const row = sqlite.prepare("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions WHERE id = ?").get(id) as SessionRow | undefined;
	if (!row) return null;
	return {
		...rowToMeta(row),
		messages: readSessionFile(id),
	};
}

export function saveChatSession(id: string, messages: ChatMessage[]): ChatSession | null {
	const sqlite = getDb();
	const row = sqlite.prepare("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions WHERE id = ?").get(id) as SessionRow | undefined;
	if (!row) return null;

	const cleanMessages = sanitizeMessages(messages);
	const now = Date.now();
	const title = computeTitle(cleanMessages, row.title || "Nueva sesion");
	const lastPreview = computeLastPreview(cleanMessages);

	writeSessionFile(id, cleanMessages);

	sqlite.prepare(`
		UPDATE chat_sessions
		SET title = @title, updated_at = @updatedAt, last_preview = @lastPreview
		WHERE id = @id
	`).run({
		id,
		title,
		updatedAt: now,
		lastPreview,
	});

	return {
		id,
		title,
		createdAt: row.created_at,
		updatedAt: now,
		lastPreview,
		messages: cleanMessages,
	};
}

export function deleteChatSession(id: string): boolean {
	const sqlite = getDb();
	const row = sqlite.prepare("SELECT id FROM chat_sessions WHERE id = ?").get(id) as { id: string } | undefined;
	if (!row) return false;
	sqlite.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id);
	const filePath = buildChatFilePath(id);
	if (existsSync(filePath)) unlinkSync(filePath);
	return true;
}

export function getOrCreateLinkedChatSession(channel: string, externalId: string, titleHint?: string): ChatSession {
	const sqlite = getDb();
	const cleanChannel = channel.trim();
	const cleanExternalId = externalId.trim();
	if (!cleanChannel || !cleanExternalId) {
		throw new Error("channel y externalId son requeridos");
	}

	const link = sqlite.prepare(`
		SELECT session_id
		FROM chat_session_links
		WHERE channel = ? AND external_id = ?
	`).get(cleanChannel, cleanExternalId) as LinkRow | undefined;

	if (link) {
		const existing = getChatSession(link.session_id);
		if (existing) return existing;
	}

	const created = createChatSession();
	if (titleHint?.trim()) {
		setSessionTitle(sqlite, created.id, titleHint);
	}

	sqlite.prepare(`
		INSERT INTO chat_session_links (channel, external_id, session_id)
		VALUES (@channel, @externalId, @sessionId)
		ON CONFLICT(channel, external_id) DO UPDATE SET session_id = excluded.session_id
	`).run({
		channel: cleanChannel,
		externalId: cleanExternalId,
		sessionId: created.id,
	});

	return getChatSession(created.id) ?? created;
}
