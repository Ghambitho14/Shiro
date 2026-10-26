/**
 * Obsidian como almacén: todo va a la carpeta "Shiro" de la bóveda, en notas Markdown. Es la memoria
 * del asistente: no lee ni busca fuera de esa carpeta.
 * - Shiro/            → SOUL.md, TOOLS.md, MEMORY.md, Instrucciones.md, Sobre mí.md y lo que escriba write_file
 * - Shiro/Agentes/    → una nota por agente de las salas
 * - Shiro/Recuerdos/  → una nota por recuerdo (memory_add); las que escribas tú también cuentan
 * - Shiro/Chats/      → copia legible de cada chat (el chat en sí sigue en el índice de este equipo)
 * - Shiro/Recordatorios.md → lista de recordatorios (copia legible)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import type { ContentPart } from "../core/agent/Types.js";

export const OBSIDIAN_FOLDER = "Shiro";

/** Carpeta de Shiro dentro de la bóveda. */
export function obsidianRoot(vault: string): string {
	return join(vault, OBSIDIAN_FOLDER);
}

// ───────────────────────────── bóvedas ─────────────────────────────

/** obsidian.json de la app de Obsidian (lista de bóvedas abiertas alguna vez). */
function obsidianConfigFile(): string {
	if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json");
	if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json");
}

/** Bóvedas que conoce la app de Obsidian de este equipo (para elegir sin escribir la ruta). */
export function listObsidianVaults(configFile = obsidianConfigFile()): { path: string; name: string }[] {
	try {
		const data = JSON.parse(readFileSync(configFile, "utf-8")) as { vaults?: Record<string, { path?: string; ts?: number }> };
		return Object.values(data.vaults ?? {})
			.filter((v): v is { path: string; ts?: number } => typeof v.path === "string" && existsSync(v.path))
			.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
			.map((v) => ({ path: v.path, name: basename(v.path) }));
	} catch {
		return [];
	}
}

/** Comprueba que la carpeta existe y se puede escribir en ella. */
export function checkVault(vault: string): { ok: true; warning?: string } | { ok: false; error: string } {
	const path = vault.trim();
	if (!path) return { ok: false, error: "Falta la carpeta de tu bóveda de Obsidian." };
	try {
		if (!statSync(path).isDirectory()) return { ok: false, error: `${path} no es una carpeta.` };
	} catch {
		return { ok: false, error: `No encuentro la carpeta ${path}.` };
	}
	const root = obsidianRoot(path);
	try {
		mkdirSync(root, { recursive: true });
		const probe = join(root, `.shiro-prueba-${process.pid}`);
		writeFileSync(probe, "ok");
		unlinkSync(probe);
	} catch (err) {
		return { ok: false, error: `No puedo escribir en ${root}: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!existsSync(join(path, ".obsidian"))) {
		return { ok: true, warning: "Esa carpeta no parece una bóveda de Obsidian (no tiene .obsidian), pero Shiro puede usarla igual." };
	}
	return { ok: true };
}

// ───────────────────────────── utilidades ─────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d: Date) => `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Texto válido como nombre de archivo en Windows, macOS y Linux (y en enlaces de Obsidian). */
export function safeFileName(text: string, max = 60): string {
	const clean = text
		.replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "");
	return (clean.slice(0, max).trim() || "Sin título").replace(/[. ]+$/, "");
}

/** Lee el bloque --- clave: valor --- del principio de una nota. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
		if (kv) meta[kv[1]] = kv[2].trim();
	}
	return { meta, body: text.slice(m[0].length) };
}

/**
 * Valor de una propiedad para el bloque ---: texto y listas entre comillas (como JSON, que también es
 * YAML válido para Obsidian), números y sí/no tal cual.
 */
export function yamlValue(v: string | number | boolean | string[]): string {
	return typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
}

/** Lee lo que escribió yamlValue, o lo que alguien escribió a mano en Obsidian (sin comillas, «a, b»…). */
export function frontValue(raw: string | undefined): string | number | boolean | string[] | undefined {
	const v = raw?.trim();
	if (!v) return undefined;
	if (v.startsWith('"') || v.startsWith("[")) {
		try {
			return JSON.parse(v) as string | string[];
		} catch {
			if (v.startsWith("[") && v.endsWith("]")) {
				return v
					.slice(1, -1)
					.split(",")
					.map((x) => x.trim().replace(/^["']|["']$/g, ""))
					.filter(Boolean);
			}
		}
	}
	if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
	if (/^(true|sí|si|yes)$/i.test(v)) return true;
	if (/^(false|no)$/i.test(v)) return false;
	if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
	return v;
}

/** Título comparable: sin tildes, mayúsculas ni signos («¿Qué debería…?» = «que deberia…»). */
export function normalizeHeading(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// ───────────────────────────── chats ─────────────────────────────

type NoteMessage = {
	role: "user" | "assistant";
	content: string | ContentPart[];
	ts?: number;
	tools?: { label: string; ok: boolean }[];
	/** En una sala: el agente que respondió. */
	agentName?: string;
};
export type NoteChat = { id: string; title: string; createdAt: number; updatedAt: number; messages: NoteMessage[] };

const chatsDir = (vault: string) => join(obsidianRoot(vault), "Chats");
const chatTag = (id: string) => `(${id.slice(0, 8)}).md`;

function messageText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content.map((p) => (p.type === "text" ? p.text : "_(imagen adjunta)_")).join("\n\n");
}

export function chatToMarkdown(chat: NoteChat, names: { user: string; assistant: string }): string {
	const lines = [
		"---",
		`shiro-chat: ${chat.id}`,
		`creado: ${localDateTime(new Date(chat.createdAt))}`,
		`actualizado: ${localDateTime(new Date(chat.updatedAt))}`,
		"---",
		`# ${chat.title}`,
		"",
	];
	for (const m of chat.messages) {
		// En una sala, el nombre enlaza a la nota del agente (Agentes/Viernes.md).
		const who = m.role === "user" ? names.user : m.agentName ? `[[Agentes/${safeFileName(m.agentName)}|${m.agentName}]]` : names.assistant;
		lines.push(`**${who}**${m.ts ? ` · ${localDateTime(new Date(m.ts))}` : ""}`, "");
		lines.push(messageText(m.content).trim(), "");
		for (const t of m.tools ?? []) lines.push(`> 🔧 ${t.label}${t.ok ? "" : " (falló)"}`);
		if (m.tools?.length) lines.push("");
	}
	return lines.join("\n");
}

/** ¿Ya hay nota para este chat? */
export function hasChatNote(vault: string, id: string): boolean {
	const dir = chatsDir(vault);
	return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(chatTag(id)));
}

/** Borra la nota de un chat (se busca por el trozo de id del nombre, por si cambió el título). */
export function removeChatNote(vault: string, id: string): void {
	const dir = chatsDir(vault);
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) if (f.endsWith(chatTag(id))) rmSync(join(dir, f), { force: true });
}

/** Escribe (o reescribe) la nota de un chat: "AAAA-MM-DD Título (id).md". */
export function writeChatNote(vault: string, chat: NoteChat, names: { user: string; assistant: string }): string {
	const dir = chatsDir(vault);
	mkdirSync(dir, { recursive: true });
	removeChatNote(vault, chat.id);
	const file = join(dir, `${localDate(new Date(chat.createdAt))} ${safeFileName(chat.title)} ${chatTag(chat.id)}`);
	writeFileSync(file, chatToMarkdown(chat, names), "utf-8");
	return file;
}

// ───────────────────────────── recordatorios ─────────────────────────────

type NoteReminder = { title: string; description?: string; datetime: string; repeat?: string; active: boolean; completed: boolean; completedAt?: string };
const REPEAT_ES: Record<string, string> = { daily: "cada día", weekly: "cada semana", monthly: "cada mes" };

export function writeRemindersNote(vault: string, reminders: NoteReminder[]): void {
	const fmt = (r: NoteReminder) => {
		const when = localDateTime(new Date(r.datetime));
		const repeat = r.repeat && REPEAT_ES[r.repeat] ? ` _(${REPEAT_ES[r.repeat]})_` : "";
		return `${when} — ${r.title}${repeat}${r.description ? `: ${r.description}` : ""}`;
	};
	const pending = reminders.filter((r) => r.active && !r.completed).sort((a, b) => a.datetime.localeCompare(b.datetime));
	const done = reminders
		.filter((r) => r.completed)
		.sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
		.slice(0, 20);
	const lines = [
		"# Recordatorios",
		"",
		"_Lista que mantiene Shiro. Para cambiar un recordatorio, pídeselo a Shiro: editar esta nota no lo cambia._",
		"",
		"## Pendientes",
		...(pending.length ? pending.map((r) => `- [ ] ${fmt(r)}`) : ["_Ninguno_"]),
		"",
		"## Hechos (últimos 20)",
		...(done.length ? done.map((r) => `- [x] ${fmt(r)}`) : ["_Ninguno_"]),
		"",
	];
	mkdirSync(obsidianRoot(vault), { recursive: true });
	writeFileSync(join(obsidianRoot(vault), "Recordatorios.md"), lines.join("\n"), "utf-8");
}

// ───────────────────────────── recuerdos ─────────────────────────────

export type NoteMemory = { id: string; content: string; type: string; tags?: string[]; createdAt: string; source?: string };

const memoriesDir = (vault: string) => join(obsidianRoot(vault), "Recuerdos");

export function writeMemoryNote(vault: string, m: NoteMemory): string {
	const dir = memoriesDir(vault);
	mkdirSync(dir, { recursive: true });
	const d = new Date(m.createdAt);
	const title = safeFileName(m.content.split(/\r?\n/)[0] ?? "", 50);
	let file = join(dir, `${localDate(d)} ${pad(d.getHours())}${pad(d.getMinutes())} ${title}.md`);
	for (let i = 2; existsSync(file); i++) file = join(dir, `${localDate(d)} ${pad(d.getHours())}${pad(d.getMinutes())} ${title} ${i}.md`);
	const tags = m.tags?.length ? `[${m.tags.map((t) => t.replace(/[,\]\[]/g, " ").trim()).join(", ")}]` : "[]";
	writeFileSync(file, ["---", `id: ${m.id}`, `tipo: ${m.type}`, `etiquetas: ${tags}`, `fecha: ${m.createdAt}`, "---", m.content.trim(), ""].join("\n"), "utf-8");
	return file;
}

/** Recuerdos guardados como notas (también los que escribas tú a mano en esa carpeta). */
export function readMemoryNotes(vault: string): NoteMemory[] {
	const dir = memoriesDir(vault);
	if (!existsSync(dir)) return [];
	const out: NoteMemory[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".md")) continue;
		const file = join(dir, f);
		try {
			const { meta, body } = parseFrontmatter(readFileSync(file, "utf-8"));
			const content = body.trim();
			if (!content) continue;
			const tags = (meta.etiquetas ?? "")
				.replace(/^\[|\]$/g, "")
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);
			out.push({
				id: meta.id || `nota:${f}`,
				content,
				type: meta.tipo || "observation",
				tags: tags.length ? tags : undefined,
				createdAt: meta.fecha || statSync(file).mtime.toISOString(),
				source: relative(obsidianRoot(vault), file),
			});
		} catch {
			// nota ilegible: se ignora
		}
	}
	return out;
}

// ───────────────────────────── búsqueda en la carpeta Shiro ─────────────────────────────

/** Notas .md de la carpeta Shiro de la bóveda (sin carpetas ocultas ni las copias de chats/recuerdos). */
export function shiroNotes(vault: string, maxFiles = 3000): string[] {
	const skip = new Set([chatsDir(vault), memoriesDir(vault)].map((p) => p.toLowerCase()));
	const files: string[] = [];
	const walk = (dir: string) => {
		if (files.length >= maxFiles || skip.has(dir.toLowerCase())) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (files.length >= maxFiles) return;
			if (e.name.startsWith(".") || e.name === "node_modules") continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (e.name.endsWith(".md")) files.push(full);
		}
	};
	walk(obsidianRoot(vault));
	return files;
}
