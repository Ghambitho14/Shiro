/**
 * Deshacer los cambios que Aku hace en archivos de un proyecto (project edit y write): antes de
 * escribir se guarda cómo estaba el archivo, y el botón «Deshacer» del chat lo devuelve a ese estado.
 * Las copias viven en data/cache/undo (solo las últimas) y nunca salen de este equipo.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../../config/config.js";

const UNDO_DIR = join(DATA_DIR, "cache", "undo");
/** Cuántas copias se guardan como mucho. */
const MAX_ENTRIES = 50;
/** Un archivo más grande no se copia (no habrá botón de deshacer). */
const MAX_BYTES = 5 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type UndoEntry = {
	id: string;
	/** Ruta completa en el disco y la que ve el usuario (Carpeta/archivo). */
	full: string;
	path: string;
	/** false: el archivo no existía; deshacer lo borra. */
	existed: boolean;
	/** Contenido anterior, en base64 para no tocar ni un byte. */
	before?: string;
	/** Huella del archivo tal como lo dejó Aku: si ya no coincide, alguien lo cambió después. */
	afterHash: string;
	ts: number;
};

export type PendingUndo = Omit<UndoEntry, "afterHash" | "ts">;

const hashOf = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const fileOf = (id: string) => join(UNDO_DIR, `${id}.json`);

/** Antes de escribir: apunta cómo está el archivo. undefined si es demasiado grande para copiarlo. */
export function beginUndo(full: string, path: string): PendingUndo | undefined {
	try {
		const existed = existsSync(full);
		if (existed && (!statSync(full).isFile() || statSync(full).size > MAX_BYTES)) return undefined;
		return { id: randomUUID(), full, path, existed, ...(existed ? { before: readFileSync(full).toString("base64") } : {}) };
	} catch {
		return undefined;
	}
}

/** Después de escribir: guarda la copia y devuelve su id (el del botón «Deshacer»). */
export function commitUndo(pending: PendingUndo | undefined): string | undefined {
	if (!pending) return undefined;
	try {
		const entry: UndoEntry = { ...pending, afterHash: hashOf(readFileSync(pending.full)), ts: Date.now() };
		mkdirSync(UNDO_DIR, { recursive: true });
		writeFileSync(fileOf(entry.id), JSON.stringify(entry), "utf-8");
		prune();
		return entry.id;
	} catch {
		return undefined;
	}
}

function prune(): void {
	const files = readdirSync(UNDO_DIR)
		.filter((f) => f.endsWith(".json"))
		.map((f) => ({ f, t: statSync(join(UNDO_DIR, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { f } of files.slice(MAX_ENTRIES)) rmSync(join(UNDO_DIR, f), { force: true });
}

export type UndoResult =
	| { ok: true; path: string; deleted: boolean }
	/** `gone`: ya no hay copia. `changed`: el archivo cambió después de que Aku lo tocó (con `force` se pisa). */
	| { ok: false; reason: "gone" | "changed"; path?: string };

/** Devuelve el archivo a como estaba antes del cambio. No pisa lo que alguien cambió después, salvo con `force`. */
export function undoChange(id: string, force = false): UndoResult {
	if (!ID_PATTERN.test(id) || !existsSync(fileOf(id))) return { ok: false, reason: "gone" };
	let entry: UndoEntry;
	try {
		entry = JSON.parse(readFileSync(fileOf(id), "utf-8")) as UndoEntry;
	} catch {
		return { ok: false, reason: "gone" };
	}
	const now = existsSync(entry.full) ? hashOf(readFileSync(entry.full)) : "";
	if (now !== entry.afterHash && !force) return { ok: false, reason: "changed", path: entry.path };
	if (entry.existed) {
		mkdirSync(dirname(entry.full), { recursive: true });
		writeFileSync(entry.full, Buffer.from(entry.before ?? "", "base64"));
	} else {
		rmSync(entry.full, { force: true });
	}
	rmSync(fileOf(id), { force: true });
	return { ok: true, path: entry.path, deleted: !entry.existed };
}
