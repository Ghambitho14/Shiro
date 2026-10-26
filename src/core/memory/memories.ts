/**
 * Recuerdos de Shiro (tools memory_add / memory_search), guardados donde diga Ajustes → Datos:
 * - local: data/memories.json
 * - obsidian: una nota por recuerdo en <bóveda>/Shiro/Recuerdos (y la búsqueda mira toda la carpeta Shiro)
 * - supabase: tabla shiro_memories
 * La búsqueda usa palabras clave y, si Ollama da embeddings, también significado (similitud).
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../../config/config.js";
import { obsidianRoot, readMemoryNotes, shiroNotes, writeMemoryNote } from "../../storage/obsidian.js";
import { currentStorage, supabaseOf, vaultOf, type StorageSettings } from "../../storage/storage.js";
import { supabaseRequest } from "../../storage/supabase.js";
import { appendLongTermMemory } from "../../workspace.js";
import { getEmbeddingsProvider } from "./EmbeddingsClient.js";

export type MemoryType = "conversation" | "tool_call" | "observation" | "decision";
export const MEMORY_TYPES: readonly MemoryType[] = ["conversation", "tool_call", "observation", "decision"];

export type Memory = {
	id: string;
	content: string;
	type: string;
	tags?: string[];
	createdAt: string;
	embedding?: number[];
	/** Nota de Obsidian de donde sale (ruta relativa a la carpeta Shiro, la que entiende read_file). */
	source?: string;
};

export type MemoryHit = { content: string; createdAt?: string; source?: string; score: number };

interface MemoryBackend {
	add(m: Memory): Promise<void>;
	all(): Promise<Memory[]>;
}

// ───────────────────────────── almacenes ─────────────────────────────

const LOCAL_FILE = join(DATA_DIR, "memories.json");

const localBackend: MemoryBackend = {
	async add(m) {
		const all = await localBackend.all();
		all.push(m);
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(LOCAL_FILE, JSON.stringify(all, null, 2), "utf-8");
	},
	async all() {
		if (!existsSync(LOCAL_FILE)) return [];
		try {
			const data = JSON.parse(readFileSync(LOCAL_FILE, "utf-8")) as unknown;
			return Array.isArray(data) ? (data as Memory[]).filter((m) => m && typeof m.content === "string") : [];
		} catch {
			return [];
		}
	},
};

function obsidianBackend(s: StorageSettings): MemoryBackend {
	return {
		async add(m) {
			writeMemoryNote(vaultOf(s), m);
		},
		async all() {
			return readMemoryNotes(vaultOf(s));
		},
	};
}

type MemoryRow = { id: string; content: string; type: string; tags: string[] | null; created_at: string; embedding: number[] | null };

function supabaseBackend(s: StorageSettings): MemoryBackend {
	const cfg = supabaseOf(s);
	return {
		async add(m) {
			await supabaseRequest(cfg, "POST", "shiro_memories?on_conflict=id", {
				body: { id: m.id, content: m.content, type: m.type, tags: m.tags ?? [], created_at: m.createdAt, embedding: m.embedding ?? null },
				prefer: "resolution=merge-duplicates,return=minimal",
			});
		},
		async all() {
			const rows = await supabaseRequest<MemoryRow[]>(cfg, "GET", "shiro_memories?select=*&order=created_at.desc&limit=5000");
			return rows.map((r) => ({
				id: r.id,
				content: r.content,
				type: r.type,
				tags: r.tags?.length ? r.tags : undefined,
				createdAt: r.created_at,
				embedding: Array.isArray(r.embedding) ? r.embedding : undefined,
			}));
		},
	};
}

export function memoryBackendFor(s: StorageSettings): MemoryBackend {
	if (s.kind === "obsidian") return obsidianBackend(s);
	if (s.kind === "supabase") return supabaseBackend(s);
	return localBackend;
}

// ───────────────────────────── embeddings (opcionales) ─────────────────────────────

/** Embedding del texto, o null si no hay servidor de embeddings (no es un error: se busca por palabras). */
async function tryEmbed(text: string, timeoutMs = 8000): Promise<number[] | null> {
	try {
		const result = await Promise.race([
			getEmbeddingsProvider().embed(text.slice(0, 4000)),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
		]);
		return Array.isArray(result) && result.length ? result : null;
	} catch {
		return null;
	}
}

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ───────────────────────────── palabras clave ─────────────────────────────

const STOPWORDS = new Set(
	"de la el los las un una unos unas que en por con para del al lo le les se su sus mi mis me te tu tus yo y o u a e es son fue ser sobre como cual cuando donde algo eso esto este esta ese esa muy mas pero sin ya hay nos the and for with".split(" "),
);

/** Palabras de una búsqueda, sin tildes ni palabras vacías ("de", "la"…). */
export function keywords(text: string): string[] {
	const words = text
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	return [...new Set(words)];
}

/** Fracción de las palabras buscadas que aparecen en el texto (0 a 1). */
export function keywordScore(words: string[], text: string): number {
	if (!words.length) return 0;
	const hay = text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
	return words.filter((w) => hay.includes(w)).length / words.length;
}

function snippet(text: string, words: string[], max = 300): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const plain = flat.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
	const found = words.map((w) => plain.indexOf(w)).filter((i) => i >= 0);
	const at = found.length ? Math.min(...found) : 0;
	const start = Math.max(0, at - 80);
	return (start > 0 ? "…" : "") + flat.slice(start, start + max) + (start + max < flat.length ? "…" : "");
}

// ───────────────────────────── API ─────────────────────────────

/** Guarda un recuerdo. Con important, también se apunta en MEMORY.md (que va siempre en el system prompt). */
export async function addMemory(input: { content: string; type?: string; tags?: string[]; important?: boolean }, s = currentStorage()): Promise<Memory> {
	const content = input.content.trim();
	if (!content) throw new Error("El recuerdo está vacío.");
	const type = MEMORY_TYPES.includes(input.type as MemoryType) ? (input.type as MemoryType) : "observation";
	const tags = input.tags?.map((t) => String(t).trim()).filter(Boolean);
	const memory: Memory = { id: `mem_${randomUUID()}`, content, type, tags: tags?.length ? tags : undefined, createdAt: new Date().toISOString() };
	// En Obsidian no se guardan embeddings (serían ruido en la nota): allí se busca por palabras.
	if (s.kind !== "obsidian") {
		const embedding = await tryEmbed(content);
		if (embedding) memory.embedding = embedding;
	}
	await memoryBackendFor(s).add(memory);
	if (input.important) appendLongTermMemory(content, s);
	return memory;
}

export async function listMemories(s = currentStorage()): Promise<Memory[]> {
	return memoryBackendFor(s).all();
}

/** Busca en los recuerdos (y, con Obsidian, en todas las notas de la carpeta Shiro). */
export async function searchMemories(query: string, limit = 5, s = currentStorage()): Promise<MemoryHit[]> {
	const words = keywords(query);
	const memories = await memoryBackendFor(s).all();
	const queryEmbedding = memories.some((m) => m.embedding?.length) ? await tryEmbed(query) : null;
	const hits: MemoryHit[] = [];
	for (const m of memories) {
		const byWords = keywordScore(words, `${m.content} ${(m.tags ?? []).join(" ")}`);
		const byMeaning = queryEmbedding && m.embedding?.length === queryEmbedding.length ? cosine(queryEmbedding, m.embedding) : 0;
		const score = Math.max(byWords, byMeaning >= 0.55 ? byMeaning : 0);
		if (score > 0) hits.push({ content: m.content, createdAt: m.createdAt, source: m.source, score });
	}
	if (s.kind === "obsidian" && words.length) {
		const root = obsidianRoot(vaultOf(s));
		for (const file of shiroNotes(vaultOf(s))) {
			let text: string;
			try {
				if (statSync(file).size > 300_000) continue;
				text = readFileSync(file, "utf-8");
			} catch {
				continue;
			}
			const score = keywordScore(words, `${file} ${text}`);
			if (score > 0) hits.push({ content: snippet(text, words), source: relative(root, file), score: score * 0.9 });
		}
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}
