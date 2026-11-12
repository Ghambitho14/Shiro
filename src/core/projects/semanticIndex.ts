/**
 * Búsqueda por significado en un proyecto (`project action=semantic`): encuentra el código o texto
 * que habla de algo aunque no use esas palabras («dónde se maneja el login» → `authenticate`).
 *
 * - Se parte cada archivo de texto en trozos de unas 40 líneas (con solape) y se calcula su
 *   significado con el modelo de embeddings (`EmbeddingsClient.ts`).
 * - El índice vive en `data/cache/semantic/<id del proyecto>.json` (siempre en este equipo).
 *   En cada búsqueda solo se recalculan los archivos que cambiaron (fecha o tamaño), los nuevos
 *   y se quitan los borrados. Con un proyecto grande, la primera vez puede quedar a medias
 *   (tiempo máximo): lo que falta se completa en las búsquedas siguientes.
 * - Si cambia el modelo de embeddings, el índice se rehace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { resolveEmbeddingsProvider, type EmbeddingsProvider } from "../memory/EmbeddingsClient.js";
import { isTextFile } from "./documents.js";
import { listProjectFiles, resolveProjectPath, type Project, type ProjectFile } from "./projects.js";

const DIR = join(DATA_DIR, "cache", "semantic");
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 8;
const CHUNK_MAX_CHARS = 2000;
const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 3000;
const MAX_CHUNKS = 15_000;
const BATCH = 32;
/** Tiempo máximo de indexado por búsqueda: lo que falte se hace en la siguiente. */
const INDEX_BUDGET_MS = 90_000;
/** Archivos generados o enormes que solo meten ruido. */
const SKIP_FILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|cargo\.lock|poetry\.lock)$|\.min\.(js|css)$|\.map$/i;

type Chunk = { start: number; end: number; vec: string };
type FileEntry = { mtime: number; size: number; chunks: Chunk[] };
type IndexFile = { model: string; files: Record<string, FileEntry> };

export type SemanticHit = { path: string; start: number; end: number; score: number; preview: string };
export type SemanticResult = { hits: SemanticHit[]; indexed: number; pending: number; updated: number; model: string };

const indexPath = (projectId: string) => join(DIR, `${projectId.replace(/[^\w-]/g, "_")}.json`);

function loadIndex(projectId: string, model: string): IndexFile {
	try {
		const data = JSON.parse(readFileSync(indexPath(projectId), "utf-8")) as IndexFile;
		if (data.model === model && data.files) return data;
	} catch {
		/* sin índice o roto: se empieza de cero */
	}
	return { model, files: {} };
}

function saveIndex(projectId: string, index: IndexFile): void {
	mkdirSync(DIR, { recursive: true });
	writeFileSync(indexPath(projectId), JSON.stringify(index), "utf-8");
}

/** Vector normalizado (largo 1, así el coseno es el producto) y guardado como base64 de Float32. */
function packVector(v: number[]): string {
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
	const f = new Float32Array(v.length);
	for (let i = 0; i < v.length; i++) f[i] = v[i] / norm;
	return Buffer.from(f.buffer).toString("base64");
}

function unpackVector(b64: string): Float32Array {
	const buf = Buffer.from(b64, "base64");
	return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Trozos de un texto: [inicio, fin] en líneas (desde 1) y el texto. */
export function chunkText(text: string): { start: number; end: number; text: string }[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: { start: number; end: number; text: string }[] = [];
	for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
		let end = Math.min(lines.length, i + CHUNK_LINES);
		let body = lines.slice(i, end).join("\n");
		if (body.length > CHUNK_MAX_CHARS) {
			// Líneas muy largas: se corta por letras y el trozo termina antes.
			body = body.slice(0, CHUNK_MAX_CHARS);
			end = i + body.split("\n").length;
		}
		if (body.trim()) out.push({ start: i + 1, end, text: body });
		if (end >= lines.length) break;
	}
	return out;
}

/** nomic-embed-text pide decir si el texto es un documento o una pregunta. */
function withTask(model: string, kind: "doc" | "query", text: string): string {
	if (!/nomic/i.test(model)) return text;
	return `${kind === "doc" ? "search_document" : "search_query"}: ${text}`;
}

function indexable(f: ProjectFile): boolean {
	return isTextFile(f.path) && f.size > 0 && f.size <= MAX_FILE_BYTES && !SKIP_FILE.test(f.path);
}

/** Un índice a la vez por proyecto (dos búsquedas seguidas no indexan dos veces). */
const running = new Map<string, Promise<unknown>>();

/** Pone al día el índice del proyecto. Devuelve cuántos archivos hay indexados, cuántos faltan y cuántos se recalcularon. */
async function updateIndex(p: Project, provider: EmbeddingsProvider, model: string, signal?: AbortSignal) {
	const index = loadIndex(p.id, model);
	const files = listProjectFiles(p, undefined, MAX_FILES).filter(indexable);
	const present = new Set(files.map((f) => f.path));
	for (const path of Object.keys(index.files)) if (!present.has(path)) delete index.files[path];
	const stale = files.filter((f) => {
		const e = index.files[f.path];
		return !e || e.mtime !== f.mtime || e.size !== f.size;
	});

	const started = Date.now();
	let chunkCount = Object.values(index.files).reduce((n, e) => n + e.chunks.length, 0);
	let updated = 0;
	let lastSave = Date.now();
	for (const f of stale) {
		if (signal?.aborted || Date.now() - started > INDEX_BUDGET_MS || chunkCount >= MAX_CHUNKS) break;
		const r = resolveProjectPath(p, f.path);
		if (!r) continue;
		let text: string;
		try {
			const data = readFileSync(r.full);
			if (data.subarray(0, 8000).includes(0)) continue; // binario con extensión de texto
			text = data.toString("utf-8");
		} catch {
			continue;
		}
		const pieces = chunkText(text);
		const chunks: Chunk[] = [];
		for (let i = 0; i < pieces.length; i += BATCH) {
			const batch = pieces.slice(i, i + BATCH);
			const vectors = await provider.embedMany(batch.map((c) => withTask(model, "doc", `${f.path}\n${c.text}`)));
			batch.forEach((c, j) => chunks.push({ start: c.start, end: c.end, vec: packVector(vectors[j]) }));
		}
		chunkCount += chunks.length - (index.files[f.path]?.chunks.length ?? 0);
		index.files[f.path] = { mtime: f.mtime, size: f.size, chunks };
		updated++;
		// Se guarda de vez en cuando: si algo corta el indexado, no se pierde lo hecho.
		if (Date.now() - lastSave > 10_000) {
			saveIndex(p.id, index);
			lastSave = Date.now();
		}
	}
	saveIndex(p.id, index);
	const indexed = files.filter((f) => {
		const e = index.files[f.path];
		return e && e.mtime === f.mtime && e.size === f.size;
	}).length;
	return { index, indexed, pending: files.length - indexed, updated };
}

/** Lee las líneas [start, end] de un archivo del proyecto para enseñarlas (recortadas). */
function preview(p: Project, path: string, start: number, end: number, maxLines = 12): string {
	const r = resolveProjectPath(p, path);
	if (!r || !existsSync(r.full)) return "";
	try {
		const lines = readFileSync(r.full, "utf-8").replace(/\r\n/g, "\n").split("\n").slice(start - 1, end);
		const shown = lines.slice(0, maxLines).map((l, i) => `${start + i}| ${l.length > 160 ? `${l.slice(0, 157)}…` : l}`);
		if (lines.length > maxLines) shown.push(`    … (hasta la línea ${end})`);
		return shown.join("\n");
	} catch {
		return "";
	}
}

/**
 * Busca por significado. Lanza un error en español si no hay modelo de embeddings: quien llama
 * le dice al modelo que use la búsqueda por palabras.
 */
export async function semanticSearch(p: Project, query: string, opts: { limit?: number; files?: (path: string) => boolean; signal?: AbortSignal } = {}): Promise<SemanticResult> {
	const q = query.trim();
	if (!q) throw new Error("Indica qué buscar (query).");
	const provider = await resolveEmbeddingsProvider();
	const model = provider.getModel();
	let queryVec: Float32Array;
	try {
		queryVec = unpackVector(packVector(await provider.embed(withTask(model, "query", q))));
	} catch (err) {
		throw new Error(
			`No hay un modelo de embeddings disponible (${err instanceof Error ? err.message : String(err)}). ` +
				"En LM Studio, descarga uno (p. ej. nomic-embed-text); con Ollama: «ollama pull nomic-embed-text». Mientras tanto, busca por palabras con action=search.",
		);
	}

	const previous = running.get(p.id);
	if (previous) await previous.catch(() => {});
	const job = updateIndex(p, provider, model, opts.signal);
	running.set(p.id, job);
	let state: Awaited<typeof job>;
	try {
		state = await job;
	} finally {
		if (running.get(p.id) === job) running.delete(p.id);
	}

	const scored: { path: string; start: number; end: number; score: number }[] = [];
	for (const [path, entry] of Object.entries(state.index.files)) {
		if (opts.files && !opts.files(path)) continue;
		for (const c of entry.chunks) {
			const v = unpackVector(c.vec);
			if (v.length !== queryVec.length) continue;
			let dot = 0;
			for (let i = 0; i < v.length; i++) dot += v[i] * queryVec[i];
			scored.push({ path, start: c.start, end: c.end, score: dot });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	// Como mucho dos trozos por archivo, para que salgan más sitios distintos.
	const perFile = new Map<string, number>();
	const hits: SemanticHit[] = [];
	for (const s of scored) {
		if (hits.length >= (opts.limit ?? 8)) break;
		const n = perFile.get(s.path) ?? 0;
		if (n >= 2) continue;
		perFile.set(s.path, n + 1);
		hits.push({ ...s, preview: preview(p, s.path, s.start, s.end) });
	}
	return { hits, indexed: state.indexed, pending: state.pending, updated: state.updated, model };
}
