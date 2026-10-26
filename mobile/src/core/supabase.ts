/**
 * Las mismas tablas que usa Shiro en el PC (Ajustes → Datos → Supabase): chats, recuerdos y notas
 * de memoria. Se habla con la API REST de Supabase (PostgREST) con la clave secreta.
 */
import { chatPreview, chatTitle, isoDay, keywords, keywordScore, newId } from "./text";
import type { Chat, ChatMessage, ChatMeta, FetchFn } from "./types";

export type SupabaseConn = { url: string; key: string; fetch?: FetchFn };

export class SupabaseError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "SupabaseError";
	}
}

export function normalizeSupabaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

/** Si pegaron la clave pública, se explica por qué no sirve (las tablas solo se abren con la secreta). */
export function supabaseKeyProblem(key: string): string | null {
	const k = key.trim();
	if (!k) return "Falta la clave de Supabase.";
	if (k.startsWith("sb_publishable_")) return "Esa es la clave pública. Usa la clave secreta (service_role o sb_secret_…), la misma que pusiste en Shiro del PC.";
	return null;
}

function explain(status: number, body: string, base: string): SupabaseError {
	let info: { message?: string; code?: string } = {};
	try {
		info = JSON.parse(body) as typeof info;
	} catch {
		info = { message: body.slice(0, 200) };
	}
	const msg = info.message ?? "";
	if (info.code === "PGRST205" || info.code === "42P01" || /could not find the table|does not exist/i.test(msg)) {
		return new SupabaseError(status, "Faltan tablas de Shiro en Supabase. En Shiro del PC: Ajustes → Datos, copia el SQL y ejecútalo en Supabase → SQL Editor.");
	}
	if (status === 401 || /invalid api key|jwt/i.test(msg)) return new SupabaseError(status, "Supabase rechazó la clave. Copia otra vez la clave secreta (service_role o sb_secret_…).");
	if (info.code === "42501" || /row-level security|permission denied/i.test(msg)) {
		return new SupabaseError(status, "Supabase no deja usar las tablas con esa clave. Usa la clave secreta, no la pública.");
	}
	if (status === 404) return new SupabaseError(status, `No encontré Supabase en ${base}. Revisa la dirección (https://xxxx.supabase.co).`);
	return new SupabaseError(status, `Supabase respondió ${status}${msg ? `: ${msg}` : ""}`);
}

export async function sbRequest<T>(
	conn: SupabaseConn,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	opts: { body?: unknown; prefer?: string } = {},
): Promise<T> {
	const base = normalizeSupabaseUrl(conn.url);
	const headers: Record<string, string> = { apikey: conn.key, Accept: "application/json" };
	if (conn.key.startsWith("eyJ")) headers.Authorization = `Bearer ${conn.key}`;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	if (opts.prefer) headers.Prefer = opts.prefer;
	let res: Response;
	try {
		res = await (conn.fetch ?? fetch)(`${base}/rest/v1/${path}`, {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		});
	} catch {
		throw new SupabaseError(0, "No pude conectar con Supabase. ¿Tienes internet? Revisa también la dirección.");
	}
	const text = await res.text();
	if (!res.ok) throw explain(res.status, text, base);
	return (text ? JSON.parse(text) : undefined) as T;
}

const eq = (v: string) => `eq.${encodeURIComponent(v)}`;
const inList = (values: string[]) => `in.(${values.map((v) => encodeURIComponent(`"${v.replace(/"/g, '\\"')}"`)).join(",")})`;

/** Comprueba la conexión y que estén las tablas que usa la app. */
export async function testSupabase(conn: SupabaseConn): Promise<string | null> {
	const problem = supabaseKeyProblem(conn.key);
	if (problem) return problem;
	if (!/^https?:\/\//i.test(conn.url.trim())) return "La dirección de Supabase tiene que empezar por https:// (ejemplo: https://xxxx.supabase.co).";
	try {
		for (const t of ["shiro_chats", "shiro_memories", "shiro_notes"]) await sbRequest(conn, "GET", `${t}?select=*&limit=1`);
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

// ───────────────────────────── chats ─────────────────────────────

type ChatRow = { id: string; title: string; created_at: number; updated_at: number; last_preview: string; messages?: unknown };

const rowMeta = (r: ChatRow): ChatMeta => ({
	id: r.id,
	title: r.title,
	createdAt: Number(r.created_at),
	updatedAt: Number(r.updated_at),
	lastPreview: r.last_preview ?? "",
});

/** Solo mensajes que se entienden (de usuario o asistente, con texto o partes). */
export function cleanMessages(raw: unknown): ChatMessage[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(m): m is ChatMessage =>
			!!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && (typeof m.content === "string" || Array.isArray(m.content)),
	);
}

export async function listChats(conn: SupabaseConn): Promise<ChatMeta[]> {
	const rows = await sbRequest<ChatRow[]>(conn, "GET", "shiro_chats?select=id,title,created_at,updated_at,last_preview&order=updated_at.desc&limit=200");
	return rows.map(rowMeta);
}

export async function getChat(conn: SupabaseConn, id: string): Promise<Chat | null> {
	const rows = await sbRequest<ChatRow[]>(conn, "GET", `shiro_chats?select=*&id=${eq(id)}`);
	return rows[0] ? { ...rowMeta(rows[0]), messages: cleanMessages(rows[0].messages) } : null;
}

/** Crea o actualiza el chat con estos mensajes (título y vista previa como en el PC). */
export async function saveChat(conn: SupabaseConn, chat: { id?: string; createdAt?: number; title?: string }, messages: ChatMessage[]): Promise<ChatMeta> {
	const now = Date.now();
	const meta: ChatMeta = {
		id: chat.id ?? newId(),
		title: chat.title && chat.title !== "Nueva sesión" ? chat.title : chatTitle(messages),
		createdAt: chat.createdAt ?? now,
		updatedAt: now,
		lastPreview: chatPreview(messages),
	};
	await sbRequest(conn, "POST", "shiro_chats?on_conflict=id", {
		body: { id: meta.id, title: meta.title, created_at: meta.createdAt, updated_at: meta.updatedAt, last_preview: meta.lastPreview, messages },
		prefer: "resolution=merge-duplicates,return=minimal",
	});
	return meta;
}

export async function deleteChat(conn: SupabaseConn, id: string): Promise<void> {
	await sbRequest(conn, "DELETE", `shiro_chats?id=${eq(id)}`);
}

// ───────────────────────────── notas de memoria ─────────────────────────────

export const NOTE_FILES = ["SOUL.md", "MEMORY.md", "Instrucciones.md", "Sobre mí.md", "_shiro.json"] as const;
export type Notes = Partial<Record<(typeof NOTE_FILES)[number], string>>;

/** Las notas que Shiro del PC sube a shiro_notes (SOUL.md, MEMORY.md, «Sobre mí»…). */
export async function getNotes(conn: SupabaseConn): Promise<Notes> {
	const rows = await sbRequest<{ path: string; content: string }[]>(conn, "GET", `shiro_notes?select=path,content&path=${inList([...NOTE_FILES])}`);
	const out: Notes = {};
	for (const r of rows) out[r.path as keyof Notes] = r.content;
	return out;
}

const MEMORY_TEMPLATE = "# MEMORY.md — Memoria a largo plazo\n\nHechos, decisiones y contexto que quieres recordar.\n";

/** Añade una línea con la fecha a MEMORY.md (si no estaba). El PC la recibe en su próxima sincronización. */
export async function appendMemoryNote(conn: SupabaseConn, text: string): Promise<boolean> {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return false;
	const rows = await sbRequest<{ content: string }[]>(conn, "GET", `shiro_notes?select=content&path=${eq("MEMORY.md")}`);
	const current = rows[0]?.content ?? MEMORY_TEMPLATE;
	if (current.toLowerCase().includes(line.toLowerCase())) return false;
	await sbRequest(conn, "POST", "shiro_notes?on_conflict=path", {
		body: { path: "MEMORY.md", content: `${current.trimEnd()}\n- ${line} _(${isoDay()})_\n`, updated_at: Date.now() },
		prefer: "resolution=merge-duplicates,return=minimal",
	});
	return true;
}

// ───────────────────────────── recuerdos ─────────────────────────────

const MEMORY_TYPES = ["fact", "preference", "decision", "observation", "event"];

export async function addMemory(conn: SupabaseConn, input: { content: string; type?: string; tags?: string[]; important?: boolean }): Promise<void> {
	const content = input.content.trim();
	if (!content) throw new Error("El recuerdo está vacío.");
	const type = MEMORY_TYPES.includes(input.type ?? "") ? input.type : "observation";
	await sbRequest(conn, "POST", "shiro_memories?on_conflict=id", {
		body: { id: `mem_${newId()}`, content, type, tags: input.tags?.filter(Boolean) ?? [], created_at: new Date().toISOString(), embedding: null },
		prefer: "resolution=merge-duplicates,return=minimal",
	});
	if (input.important) await appendMemoryNote(conn, content);
}

/** Busca por palabras clave (los embeddings son cosa del PC; aquí no hay servidor para calcularlos). */
export async function searchMemories(conn: SupabaseConn, query: string, limit = 5): Promise<{ content: string; createdAt: string }[]> {
	const words = keywords(query);
	const rows = await sbRequest<{ content: string; tags: string[] | null; created_at: string }[]>(
		conn,
		"GET",
		"shiro_memories?select=content,tags,created_at&order=created_at.desc&limit=5000",
	);
	return rows
		.map((r) => ({ content: r.content, createdAt: r.created_at, score: keywordScore(words, `${r.content} ${(r.tags ?? []).join(" ")}`) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, limit))
		.map(({ content, createdAt }) => ({ content, createdAt }));
}
