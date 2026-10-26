/**
 * Dónde viven los chats. ChatStore.ts decide el título/resumen y llama a uno de estos almacenes:
 * - memoria: si persistChatHistory es false (se pierden al cerrar)
 * - local: índice sql.js (data/chat-index.sqlite) + un JSON por chat (data/chats/<id>.json)
 * - obsidian: el local + una copia legible de cada chat en <bóveda>/Shiro/Chats
 * - supabase: tablas shiro_chats y shiro_chat_links
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { DATA_DIR } from "../config/config.js";
import { readAppFile, SQL_WASM_FILE } from "../runtime.js";
import { getState } from "../store.js";
import { getUserProfile } from "../user-profile.js";
import { removeChatNote, writeChatNote } from "../storage/obsidian.js";
import { supabaseOf, vaultOf, type StorageSettings } from "../storage/storage.js";
import { eq, supabaseRequest, type SupabaseConfig } from "../storage/supabase.js";
import type { ChatMessage, ChatSession, ChatSessionMeta } from "./ChatStore.js";

export type ChatLink = { channel: string; externalId: string; sessionId: string };
export type ChatPatch = Partial<Pick<ChatSession, "title" | "updatedAt" | "lastPreview" | "messages">>;

export interface ChatBackend {
	list(): Promise<ChatSessionMeta[]>;
	meta(id: string): Promise<ChatSessionMeta | null>;
	get(id: string): Promise<ChatSession | null>;
	/** Crea el chat, o lo reemplaza entero si ya existe (se usa al llevar los datos de un sitio a otro). */
	insert(session: ChatSession): Promise<void>;
	update(id: string, patch: ChatPatch): Promise<boolean>;
	remove(id: string): Promise<boolean>;
	findLink(channel: string, externalId: string): Promise<string | null>;
	setLink(channel: string, externalId: string, sessionId: string): Promise<void>;
	links(): Promise<ChatLink[]>;
}

const toMeta = ({ id, title, createdAt, updatedAt, lastPreview }: ChatSessionMeta): ChatSessionMeta => ({ id, title, createdAt, updatedAt, lastPreview });

// ───────────────────────────── en memoria ─────────────────────────────

export function createMemoryBackend(): ChatBackend {
	const sessions = new Map<string, ChatSession>();
	const links = new Map<string, ChatLink>();
	return {
		async list() {
			return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toMeta);
		},
		async meta(id) {
			const s = sessions.get(id);
			return s ? toMeta(s) : null;
		},
		async get(id) {
			return sessions.get(id) ?? null;
		},
		async insert(session) {
			sessions.set(session.id, session);
		},
		async update(id, patch) {
			const s = sessions.get(id);
			if (!s) return false;
			sessions.set(id, { ...s, ...patch });
			return true;
		},
		async remove(id) {
			for (const [key, link] of links) if (link.sessionId === id) links.delete(key);
			return sessions.delete(id);
		},
		async findLink(channel, externalId) {
			return links.get(`${channel}:${externalId}`)?.sessionId ?? null;
		},
		async setLink(channel, externalId, sessionId) {
			links.set(`${channel}:${externalId}`, { channel, externalId, sessionId });
		},
		async links() {
			return [...links.values()];
		},
	};
}

// ───────────────────────────── local (sql.js + JSON) ─────────────────────────────

const CHAT_DIR = join(DATA_DIR, "chats");
const DB_FILE = join(DATA_DIR, "chat-index.sqlite");

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let db: SqlJsDatabase | null = null;

async function getDb(): Promise<SqlJsDatabase> {
	if (db) return db;
	mkdirSync(CHAT_DIR, { recursive: true });
	// El motor se lee con readAppFile para que también funcione dentro de Shiro.exe.
	SQL ??= await initSqlJs({ wasmBinary: readAppFile(SQL_WASM_FILE) ?? undefined });
	db = existsSync(DB_FILE) ? new SQL.Database(readFileSync(DB_FILE)) : new SQL.Database();
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
	if (db) writeFileSync(DB_FILE, Buffer.from(db.export()));
}

const chatFile = (id: string) => join(CHAT_DIR, `${id}.json`);

function writeMessages(id: string, messages: ChatMessage[]): void {
	mkdirSync(CHAT_DIR, { recursive: true });
	writeFileSync(chatFile(id), JSON.stringify({ id, messages }, null, 2), "utf-8");
}

function readMessages(id: string, sanitize: (raw: unknown) => ChatMessage[]): ChatMessage[] {
	if (!existsSync(chatFile(id))) return [];
	try {
		return sanitize((JSON.parse(readFileSync(chatFile(id), "utf-8")) as { messages?: unknown }).messages);
	} catch {
		return [];
	}
}

function selectRows(sqlite: SqlJsDatabase, sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
	const stmt = sqlite.prepare(sql);
	try {
		stmt.bind(params);
		const rows: Record<string, unknown>[] = [];
		while (stmt.step()) rows.push(stmt.getAsObject());
		return rows;
	} finally {
		stmt.free();
	}
}

const rowToMeta = (r: Record<string, unknown>): ChatSessionMeta => ({
	id: String(r.id),
	title: String(r.title),
	createdAt: Number(r.created_at),
	updatedAt: Number(r.updated_at),
	lastPreview: (r.last_preview as string | null) ?? "",
});

export function createLocalBackend(sanitize: (raw: unknown) => ChatMessage[]): ChatBackend {
	const meta = async (id: string) => {
		const [row] = selectRows(await getDb(), "SELECT id, title, created_at, updated_at, last_preview FROM chat_sessions WHERE id = ?", [id]);
		return row ? rowToMeta(row) : null;
	};
	return {
		async list() {
			return selectRows(await getDb(), "SELECT id, title, created_at, updated_at, last_preview FROM chat_sessions ORDER BY updated_at DESC").map(rowToMeta);
		},
		meta,
		async get(id) {
			const m = await meta(id);
			return m ? { ...m, messages: readMessages(id, sanitize) } : null;
		},
		async insert(s) {
			const sqlite = await getDb();
			writeMessages(s.id, s.messages);
			sqlite.run(
				`INSERT INTO chat_sessions (id, title, file_path, created_at, updated_at, last_preview) VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at, last_preview = excluded.last_preview`,
				[s.id, s.title, chatFile(s.id), s.createdAt, s.updatedAt, s.lastPreview],
			);
			saveDb();
		},
		async update(id, patch) {
			const sqlite = await getDb();
			if (!(await meta(id))) return false;
			if (patch.messages) writeMessages(id, patch.messages);
			const sets: string[] = [];
			const params: (string | number)[] = [];
			if (patch.title !== undefined) sets.push("title = ?"), params.push(patch.title);
			if (patch.updatedAt !== undefined) sets.push("updated_at = ?"), params.push(patch.updatedAt);
			if (patch.lastPreview !== undefined) sets.push("last_preview = ?"), params.push(patch.lastPreview);
			if (sets.length) {
				sqlite.run(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);
				saveDb();
			}
			return true;
		},
		async remove(id) {
			const sqlite = await getDb();
			if (!(await meta(id))) return false;
			sqlite.run("DELETE FROM chat_sessions WHERE id = ?", [id]);
			saveDb();
			if (existsSync(chatFile(id))) unlinkSync(chatFile(id));
			return true;
		},
		async findLink(channel, externalId) {
			const [row] = selectRows(await getDb(), "SELECT session_id FROM chat_session_links WHERE channel = ? AND external_id = ?", [channel, externalId]);
			return row ? String(row.session_id) : null;
		},
		async setLink(channel, externalId, sessionId) {
			(await getDb()).run(
				"INSERT INTO chat_session_links (channel, external_id, session_id) VALUES (?, ?, ?) ON CONFLICT(channel, external_id) DO UPDATE SET session_id = excluded.session_id",
				[channel, externalId, sessionId],
			);
			saveDb();
		},
		async links() {
			return selectRows(await getDb(), "SELECT channel, external_id, session_id FROM chat_session_links").map((r) => ({
				channel: String(r.channel),
				externalId: String(r.external_id),
				sessionId: String(r.session_id),
			}));
		},
	};
}

// ───────────────────────────── Obsidian (local + nota) ─────────────────────────────

function noteNames() {
	return { user: getUserProfile().userName || "Tú", assistant: getState().name };
}

/** Escribe la nota del chat. Si falla (bóveda desconectada…), el chat ya quedó guardado en local. */
export function mirrorChatToObsidian(vault: string, session: ChatSession): void {
	try {
		writeChatNote(vault, session, noteNames());
	} catch (err) {
		console.error(`[Obsidian] No pude escribir la nota del chat "${session.title}": ${err instanceof Error ? err.message : String(err)}`);
	}
}

function createObsidianBackend(local: ChatBackend, settings: StorageSettings): ChatBackend {
	const vault = () => vaultOf(settings);
	const mirror = async (id: string) => {
		const s = await local.get(id);
		if (!s) return;
		try {
			mirrorChatToObsidian(vault(), s);
		} catch (err) {
			console.error(`[Obsidian] ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	return {
		...local,
		async insert(s) {
			await local.insert(s);
			await mirror(s.id);
		},
		async update(id, patch) {
			const ok = await local.update(id, patch);
			if (ok) await mirror(id);
			return ok;
		},
		async remove(id) {
			const ok = await local.remove(id);
			try {
				removeChatNote(vault(), id);
			} catch (err) {
				console.error(`[Obsidian] ${err instanceof Error ? err.message : String(err)}`);
			}
			return ok;
		},
	};
}

// ───────────────────────────── Supabase ─────────────────────────────

type ChatRow = { id: string; title: string; created_at: number; updated_at: number; last_preview: string; messages?: unknown };

const rowMeta = (r: ChatRow): ChatSessionMeta => ({
	id: r.id,
	title: r.title,
	createdAt: Number(r.created_at),
	updatedAt: Number(r.updated_at),
	lastPreview: r.last_preview ?? "",
});

export function createSupabaseBackend(cfg: SupabaseConfig, sanitize: (raw: unknown) => ChatMessage[]): ChatBackend {
	const META = "select=id,title,created_at,updated_at,last_preview";
	const meta = async (id: string) => {
		const rows = await supabaseRequest<ChatRow[]>(cfg, "GET", `shiro_chats?${META}&id=${eq(id)}`);
		return rows[0] ? rowMeta(rows[0]) : null;
	};
	return {
		async list() {
			return (await supabaseRequest<ChatRow[]>(cfg, "GET", `shiro_chats?${META}&order=updated_at.desc`)).map(rowMeta);
		},
		meta,
		async get(id) {
			const rows = await supabaseRequest<ChatRow[]>(cfg, "GET", `shiro_chats?select=*&id=${eq(id)}`);
			return rows[0] ? { ...rowMeta(rows[0]), messages: sanitize(rows[0].messages) } : null;
		},
		async insert(s) {
			await supabaseRequest(cfg, "POST", "shiro_chats?on_conflict=id", {
				body: { id: s.id, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt, last_preview: s.lastPreview, messages: s.messages },
				prefer: "resolution=merge-duplicates,return=minimal",
			});
		},
		async update(id, patch) {
			const body: Record<string, unknown> = {};
			if (patch.title !== undefined) body.title = patch.title;
			if (patch.updatedAt !== undefined) body.updated_at = patch.updatedAt;
			if (patch.lastPreview !== undefined) body.last_preview = patch.lastPreview;
			if (patch.messages !== undefined) body.messages = patch.messages;
			const rows = await supabaseRequest<{ id: string }[]>(cfg, "PATCH", `shiro_chats?id=${eq(id)}&select=id`, { body, prefer: "return=representation" });
			return rows.length > 0;
		},
		async remove(id) {
			const rows = await supabaseRequest<{ id: string }[]>(cfg, "DELETE", `shiro_chats?id=${eq(id)}&select=id`, { prefer: "return=representation" });
			return rows.length > 0;
		},
		async findLink(channel, externalId) {
			const rows = await supabaseRequest<{ session_id: string }[]>(cfg, "GET", `shiro_chat_links?select=session_id&channel=${eq(channel)}&external_id=${eq(externalId)}`);
			return rows[0]?.session_id ?? null;
		},
		async setLink(channel, externalId, sessionId) {
			await supabaseRequest(cfg, "POST", "shiro_chat_links?on_conflict=channel,external_id", {
				body: { channel, external_id: externalId, session_id: sessionId },
				prefer: "resolution=merge-duplicates,return=minimal",
			});
		},
		async links() {
			const rows = await supabaseRequest<{ channel: string; external_id: string; session_id: string }[]>(cfg, "GET", "shiro_chat_links?select=*");
			return rows.map((r) => ({ channel: r.channel, externalId: r.external_id, sessionId: r.session_id }));
		},
	};
}

// ───────────────────────────── elección ─────────────────────────────

/** Almacén de chats para unos ajustes de almacenamiento. */
export function chatBackendFor(settings: StorageSettings, sanitize: (raw: unknown) => ChatMessage[]): ChatBackend {
	if (settings.kind === "supabase") return createSupabaseBackend(supabaseOf(settings), sanitize);
	const local = createLocalBackend(sanitize);
	return settings.kind === "obsidian" ? createObsidianBackend(local, settings) : local;
}
