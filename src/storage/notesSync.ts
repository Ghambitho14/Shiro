/**
 * Con Supabase, las notas que el modelo lee en cada respuesta (SOUL.md, MEMORY.md, «Sobre mí»…)
 * también viven en la tabla shiro_notes: así la app del móvil y otros equipos saben lo mismo.
 * En este equipo siguen siendo archivos (se leen al momento, sin esperar a internet) y se
 * sincronizan: al arrancar, cada 20 s y justo después de cambiar una aquí.
 *
 * Para saber qué lado cambió se guarda, por nota, cómo estaba en la última sincronización
 * (data/cache/notes-sync.json). Si cambiaron los dos: MEMORY.md junta las líneas de ambos y
 * el resto se queda con la versión más nueva.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config/config.js";
import { getState } from "../store.js";
import { INSTRUCTIONS_NOTE, LOCAL_WORKSPACE_DIR, NOTE_TEMPLATES, PROFILE_NOTE } from "../workspace.js";
import { currentStorage, supabaseOf, type StorageSettings } from "./storage.js";
import { SupabaseError, inList, supabaseRequest, type SupabaseConfig } from "./supabase.js";

/** Notas que se comparten. Las habilidades, los agentes y lo técnico se quedan en este equipo. */
export const SYNCED_NOTES = ["SOUL.md", "TOOLS.md", "MEMORY.md", INSTRUCTIONS_NOTE, PROFILE_NOTE] as const;

/** Fila con datos de este Shiro que la app del móvil necesita (el nombre del asistente). Solo se sube. */
export const SHIRO_INFO_ROW = "_shiro.json";

type NoteRow = { path: string; content: string; updated_at: number };
type NoteState = { hash: string; remoteAt: number };
type SyncState = Record<string, Record<string, NoteState>>;

const STATE_FILE = join(DATA_DIR, "cache", "notes-sync.json");
const INTERVAL_MS = 20_000;

const clean = (text: string) => text.replace(/\r\n/g, "\n").trimEnd() + "\n";
const hashOf = (text: string) => createHash("sha256").update(clean(text)).digest("hex");

function loadState(): SyncState {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as SyncState;
	} catch {
		return {};
	}
}

function saveState(state: SyncState): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/** MEMORY.md cambiada en los dos lados: se queda la de aquí y se añaden las líneas que solo tenía la otra. */
export function mergeMemoryNotes(local: string, remote: string): string {
	const have = new Set(local.split("\n").map((l) => l.trim()).filter(Boolean));
	const extra = remote.split("\n").filter((l) => l.trim() && !have.has(l.trim()));
	return extra.length ? clean(`${local.trimEnd()}\n${extra.join("\n")}`) : clean(local);
}

const isTemplate = (path: string, text: string) => clean(text) === clean(NOTE_TEMPLATES[path] ?? "");

export type NotesSyncResult = { pulled: string[]; pushed: string[] };

/**
 * Sincroniza las notas de `dir` con shiro_notes. `now` y las fechas de los archivos deciden quién
 * gana cuando cambiaron los dos lados.
 */
export async function syncNotesWith(cfg: SupabaseConfig, dir = LOCAL_WORKSPACE_DIR): Promise<NotesSyncResult> {
	const result: NotesSyncResult = { pulled: [], pushed: [] };
	const rows = await supabaseRequest<NoteRow[]>(cfg, "GET", `shiro_notes?select=path,content,updated_at&path=${inList([...SYNCED_NOTES, SHIRO_INFO_ROW])}`);
	const remote = new Map(rows.map((r) => [r.path, { ...r, updated_at: Number(r.updated_at) }]));
	const all = loadState();
	const state = (all[cfg.url] ??= {});
	const upload: NoteRow[] = [];

	for (const path of SYNCED_NOTES) {
		const file = join(dir, path);
		const local = existsSync(file) ? clean(readFileSync(file, "utf-8")) : null;
		const theirs = remote.get(path);
		const before = state[path];
		const take = (text: string, at: number) => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, clean(text), "utf-8");
			state[path] = { hash: hashOf(text), remoteAt: at };
			result.pulled.push(path);
		};
		const give = (text: string) => {
			upload.push({ path, content: clean(text), updated_at: Date.now() });
			result.pushed.push(path);
		};

		if (!theirs) {
			if (local !== null) give(local);
			continue;
		}
		if (local === null) {
			take(theirs.content, theirs.updated_at);
			continue;
		}
		if (clean(theirs.content) === local) {
			state[path] = { hash: hashOf(local), remoteAt: theirs.updated_at };
			continue;
		}
		const localChanged = !before || before.hash !== hashOf(local);
		const remoteChanged = !before || theirs.updated_at > before.remoteAt;
		if (remoteChanged && !localChanged) take(theirs.content, theirs.updated_at);
		else if (localChanged && !remoteChanged) give(local);
		else if (path === "MEMORY.md") {
			const merged = mergeMemoryNotes(local, theirs.content);
			if (merged !== local) take(merged, theirs.updated_at);
			give(merged);
		} else if (isTemplate(path, local)) take(theirs.content, theirs.updated_at);
		else if (isTemplate(path, theirs.content)) give(local);
		else if (statSync(file).mtimeMs > theirs.updated_at) give(local);
		else take(theirs.content, theirs.updated_at);
	}

	// El nombre del asistente, para que la app del móvil se llame igual.
	const info = JSON.stringify({ assistantName: getState().name });
	if (remote.get(SHIRO_INFO_ROW)?.content !== info) upload.push({ path: SHIRO_INFO_ROW, content: info, updated_at: Date.now() });

	if (upload.length) {
		await supabaseRequest(cfg, "POST", "shiro_notes?on_conflict=path", { body: upload, prefer: "resolution=merge-duplicates,return=minimal" });
		for (const row of upload) if (row.path !== SHIRO_INFO_ROW) state[row.path] = { hash: hashOf(row.content), remoteAt: row.updated_at };
	}
	if (result.pulled.length || upload.length || rows.length) saveState(all);
	return result;
}

let running: Promise<NotesSyncResult | null> | null = null;
let lastError = "";

/** Sincroniza si Ajustes → Datos es Supabase. Nunca lanza: un fallo de red no puede romper el chat. */
export function syncNotes(s: StorageSettings = currentStorage()): Promise<NotesSyncResult | null> {
	if (s.kind !== "supabase" || !s.supabaseUrl || !s.supabaseKey) return Promise.resolve(null);
	if (running) return running;
	running = (async () => {
		try {
			const r = await syncNotesWith(supabaseOf(s));
			lastError = "";
			return r;
		} catch (err) {
			const msg =
				err instanceof SupabaseError && err.missingTables
					? "Falta la tabla shiro_notes en Supabase: copia otra vez el SQL de Ajustes → Datos y ejecútalo en Supabase → SQL Editor."
					: err instanceof Error
						? err.message
						: String(err);
			// El mismo error cada 20 s no llena el registro: se avisa una vez.
			if (msg !== lastError) console.error(`[Supabase] No pude sincronizar las notas de memoria: ${msg}`);
			lastError = msg;
			return null;
		} finally {
			running = null;
		}
	})();
	return running;
}

let timer: NodeJS.Timeout | null = null;
let soon: NodeJS.Timeout | null = null;

/** Sincroniza ya y luego cada 20 s (no hace nada mientras no se use Supabase). */
export function startNotesSync(): void {
	if (timer) return;
	void syncNotes();
	timer = setInterval(() => void syncNotes(), INTERVAL_MS);
	timer.unref();
}

/** Una nota cambió aquí: se sube en un momento (varios cambios seguidos van juntos). */
export function pushNotesSoon(): void {
	if (soon) clearTimeout(soon);
	soon = setTimeout(() => {
		soon = null;
		void syncNotes();
	}, 1500);
	soon.unref();
}
