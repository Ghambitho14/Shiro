import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { DATA_DIR, getConfig } from "../config/config.js";
import type { ContentPart } from "../core/agent/Types.js";
import { getMessagePreview } from "../core/agent/contentUtils.js";

export type ChatMessage = {
	role: "user" | "assistant";
	/** Texto o, en mensajes de usuario, array de partes (texto + imagen) para visión. */
	content: string | ContentPart[];
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

// When persistChatHistory is disabled, keep sessions in memory only.
const memorySessions = new Map<string, ChatSession>();
const memoryLinks = new Map<string, string>();

function persistChatHistory(): boolean {
	return getConfig().persistChatHistory !== false;
}

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

let db: SqlJsDatabase | null = null;

function ensureDir(path: string): void {
	if (!persistChatHistory()) return;
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<NonNullable<typeof SQL>> {
	if (SQL) return SQL as NonNullable<typeof SQL>;
	SQL = await initSqlJs();
	return SQL as NonNullable<typeof SQL>;
}

async function getDb(): Promise<SqlJsDatabase> {
	if (!persistChatHistory()) {
		throw new Error("Chat persistence is disabled");
	}
	if (db) return db;
	ensureDir(DATA_DIR);
	ensureDir(CHAT_DIR);
	const SqlEngine = await getSql();
	
	if (existsSync(DB_FILE)) {
		const buffer = readFileSync(DB_FILE);
		db = new SqlEngine.Database(buffer);
	} else {
		db = new SqlEngine.Database();
	}
	
	db.run("PRAGMA foreign_keys = ON");
	db.run(`
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
	saveDb();
	return db;
}

function saveDb(): void {
	if (!db) return;
	const data = db.export();
	const buffer = Buffer.from(data);
	writeFileSync(DB_FILE, buffer);
}

function buildChatFilePath(id: string): string {
	return join(CHAT_DIR, `${id}.json`);
}

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

export function sanitizeMessages(input: unknown): ChatMessage[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const role = (item as { role?: unknown }).role;
			const content = (item as { content?: unknown }).content;
			if (role !== "user" && role !== "assistant") return null;
			if (typeof content === "string") {
				const trimmed = content.trim();
				if (!trimmed) return null;
				return { role, content: trimmed } as ChatMessage;
			}
			if (isContentPartArray(content)) {
				const hasText = content.some((p) => (p as ContentPart).type === "text" && String((p as { text?: string }).text).trim());
				const hasImage = content.some((p) => (p as ContentPart).type === "image_url");
				if (!hasText && !hasImage) return null;
				return { role, content } as ChatMessage;
			}
			return null;
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

function setSessionTitle(sqlite: SqlJsDatabase, id: string, title: string): void {
	const trimmed = title.trim();
	if (!trimmed) return;
	sqlite.run("UPDATE chat_sessions SET title = ? WHERE id = ?", [trimmed, id]);
	saveDb();
}

function writeSessionFile(id: string, messages: ChatMessage[]): void {
	if (!persistChatHistory()) return;
	ensureDir(CHAT_DIR);
	const filePath = buildChatFilePath(id);
	writeFileSync(filePath, JSON.stringify({ id, messages }, null, 2), "utf-8");
}

function readSessionFile(id: string): ChatMessage[] {
	if (!persistChatHistory()) return [];
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

export async function listChatSessions(): Promise<ChatSessionMeta[]> {
	if (!persistChatHistory()) {
		return Array.from(memorySessions.values())
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(({ id, title, createdAt, updatedAt, lastPreview }) => ({
				id,
				title,
				createdAt,
				updatedAt,
				lastPreview,
			}));
	}

	const sqlite = await getDb();
	const result = sqlite.exec("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions ORDER BY updated_at DESC");
	if (!result.length) return [];
	const rows = result[0].values.map((row: unknown[]) => ({
		id: row[0] as string,
		title: row[1] as string,
		file_path: row[2] as string,
		created_at: row[3] as number,
		updated_at: row[4] as number,
		last_preview: row[5] as string | null,
	})) as SessionRow[];
	return rows.map(rowToMeta);
}

export async function createChatSession(initialMessages: ChatMessage[] = []): Promise<ChatSession> {
	const now = Date.now();
	const id = randomUUID();
	const cleanMessages = sanitizeMessages(initialMessages);
	const title = computeTitle(cleanMessages);
	const lastPreview = computeLastPreview(cleanMessages);

	if (!persistChatHistory()) {
		const session: ChatSession = {
			id,
			title,
			createdAt: now,
			updatedAt: now,
			lastPreview,
			messages: cleanMessages,
		};
		memorySessions.set(id, session);
		return session;
	}

	const sqlite = await getDb();
	const filePath = buildChatFilePath(id);

	writeSessionFile(id, cleanMessages);

	sqlite.run(
		"INSERT INTO chat_sessions (id, title, file_path, created_at, updated_at, last_preview) VALUES (?, ?, ?, ?, ?, ?)",
		[id, title, filePath, now, now, lastPreview]
	);
	saveDb();

	return {
		id,
		title,
		createdAt: now,
		updatedAt: now,
		lastPreview,
		messages: cleanMessages,
	};
}

export async function getChatSession(id: string): Promise<ChatSession | null> {
	if (!persistChatHistory()) {
		return memorySessions.get(id) ?? null;
	}

	const sqlite = await getDb();
	const stmt = sqlite.prepare("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions WHERE id = ?");
	stmt.bind([id]);
	if (!stmt.step()) {
		stmt.free();
		return null;
	}
	const row = stmt.getAsObject() as SessionRow;
	stmt.free();
	return {
		...rowToMeta(row),
		messages: readSessionFile(id),
	};
}

export async function saveChatSession(id: string, messages: ChatMessage[]): Promise<ChatSession | null> {
	const cleanMessages = sanitizeMessages(messages);
	const now = Date.now();
	const title = computeTitle(cleanMessages);
	const lastPreview = computeLastPreview(cleanMessages);

	if (!persistChatHistory()) {
		const existing = memorySessions.get(id);
		if (!existing) return null;
		const session: ChatSession = {
			id,
			title: title || existing.title,
			createdAt: existing.createdAt,
			updatedAt: now,
			lastPreview,
			messages: cleanMessages,
		};
		memorySessions.set(id, session);
		return session;
	}

	const sqlite = await getDb();
	const stmt = sqlite.prepare("SELECT id, title, file_path, created_at, updated_at, last_preview FROM chat_sessions WHERE id = ?");
	stmt.bind([id]);
	if (!stmt.step()) {
		stmt.free();
		return null;
	}
	const row = stmt.getAsObject() as SessionRow;
	stmt.free();

	const resolvedTitle = title || row.title || "Nueva sesión";

	writeSessionFile(id, cleanMessages);

	sqlite.run("UPDATE chat_sessions SET title = ?, updated_at = ?, last_preview = ? WHERE id = ?", [resolvedTitle, now, lastPreview, id]);
	saveDb();

	return {
		id,
		title: resolvedTitle,
		createdAt: row.created_at,
		updatedAt: now,
		lastPreview,
		messages: cleanMessages,
	};
}

export async function renameChatSession(id: string, title: string): Promise<ChatSession | null> {
	const trimmed = title.trim();
	if (!trimmed) return null;
	const now = Date.now();
	if (!persistChatHistory()) {
		const existing = memorySessions.get(id);
		if (!existing) return null;
		const session: ChatSession = { ...existing, title: trimmed, updatedAt: now };
		memorySessions.set(id, session);
		return session;
	}
	const sqlite = await getDb();
	const stmt = sqlite.prepare("SELECT id FROM chat_sessions WHERE id = ?");
	stmt.bind([id]);
	if (!stmt.step()) {
		stmt.free();
		return null;
	}
	stmt.free();
	sqlite.run("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?", [trimmed, now, id]);
	saveDb();
	return getChatSession(id);
}

export async function deleteChatSession(id: string): Promise<boolean> {
	if (!persistChatHistory()) {
		const existed = memorySessions.delete(id);
		for (const [key, sessionId] of Array.from(memoryLinks.entries())) {
			if (sessionId === id) memoryLinks.delete(key);
		}
		return existed;
	}

	const sqlite = await getDb();
	const stmt = sqlite.prepare("SELECT id FROM chat_sessions WHERE id = ?");
	stmt.bind([id]);
	if (!stmt.step()) {
		stmt.free();
		return false;
	}
	stmt.free();
	
	sqlite.run("DELETE FROM chat_sessions WHERE id = ?", [id]);
	saveDb();
	const filePath = buildChatFilePath(id);
	if (existsSync(filePath)) unlinkSync(filePath);
	return true;
}

export async function getOrCreateLinkedChatSession(channel: string, externalId: string, titleHint?: string): Promise<ChatSession> {
	const cleanChannel = channel.trim();
	const cleanExternalId = externalId.trim();
	if (!cleanChannel || !cleanExternalId) {
		throw new Error("channel y externalId son requeridos");
	}

	const key = `${cleanChannel}:${cleanExternalId}`;
	if (!persistChatHistory()) {
		const existingSessionId = memoryLinks.get(key);
		if (existingSessionId) {
			const existing = await getChatSession(existingSessionId);
			if (existing) return existing;
		}

		const created = await createChatSession();
		if (titleHint?.trim()) {
			created.title = titleHint.trim();
		}
		memoryLinks.set(key, created.id);
		return created;
	}

	const sqlite = await getDb();
	const stmt = sqlite.prepare("SELECT session_id FROM chat_session_links WHERE channel = ? AND external_id = ?");
	stmt.bind([cleanChannel, cleanExternalId]);
	const hasRow = stmt.step();
	let linkRow: LinkRow | undefined;
	if (hasRow) {
		linkRow = stmt.getAsObject() as LinkRow;
	}
	stmt.free();

	if (linkRow) {
		const existing = await getChatSession(linkRow.session_id);
		if (existing) return existing;
	}

	const created = await createChatSession();
	if (titleHint?.trim()) {
		setSessionTitle(sqlite, created.id, titleHint);
	}

	sqlite.run(
		"INSERT INTO chat_session_links (channel, external_id, session_id) VALUES (?, ?, ?) ON CONFLICT(channel, external_id) DO UPDATE SET session_id = excluded.session_id",
		[cleanChannel, cleanExternalId, created.id]
	);
	saveDb();

	return (await getChatSession(created.id)) ?? created;
}
