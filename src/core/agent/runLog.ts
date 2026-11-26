/**
 * Registro de cada respuesta de Aku: qué modelo, cuánto tardó, qué herramientas usó (con su tiempo y si
 * fallaron), cuántos tokens gastó y cómo terminó. Sirve para entender por qué una respuesta salió mal.
 *
 * Va en `data/logs/runs.jsonl` (una línea por respuesta), siempre en este equipo. Al pasar de 2 MB se
 * renombra a `runs.old.jsonl` (se pisa el anterior), así nunca ocupa más de ~4 MB. Del mensaje del
 * usuario solo se guarda el comienzo; nunca los argumentos ni los resultados de las herramientas.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";

export type RunToolEntry = { name: string; ms: number; ok: boolean; error?: string };

export type RunOutcome = "ok" | "error" | "cancelled" | "empty";

export type RunLogEntry = {
	at: string;
	durationMs: number;
	sessionId?: string;
	agent: string;
	/** Lo hizo un ayudante de `delegate`. */
	subagent?: boolean;
	mode: string;
	permissions: string;
	provider?: string;
	model?: string;
	/** El comienzo del mensaje del usuario. */
	goal: string;
	/** Recuerdos que se trajeron solos. */
	recalled: number;
	tools: RunToolEntry[];
	usage: { input: number; output: number; turns: number };
	outcome: RunOutcome;
	error?: string;
};

const MAX_BYTES = 2 * 1024 * 1024;
const GOAL_CHARS = 120;
const ERROR_CHARS = 300;

function logDir(): string {
	return join(DATA_DIR, "logs");
}
const currentFile = () => join(logDir(), "runs.jsonl");
const oldFile = () => join(logDir(), "runs.old.jsonl");

const clip = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

/** Apunta una respuesta. Nunca lanza: si no se puede escribir, la respuesta sigue igual. */
export function appendRunLog(entry: RunLogEntry): void {
	try {
		mkdirSync(logDir(), { recursive: true });
		const file = currentFile();
		if (existsSync(file) && statSync(file).size > MAX_BYTES) {
			rmSync(oldFile(), { force: true });
			renameSync(file, oldFile());
		}
		const safe: RunLogEntry = {
			...entry,
			goal: clip(entry.goal, GOAL_CHARS),
			error: entry.error ? clip(entry.error, ERROR_CHARS) : undefined,
			tools: entry.tools.map((t) => ({ ...t, error: t.error ? clip(t.error, ERROR_CHARS) : undefined })),
		};
		appendFileSync(file, JSON.stringify(safe) + "\n", "utf-8");
	} catch {
		/* el registro es una ayuda, no puede romper una respuesta */
	}
}

function readLines(file: string): RunLogEntry[] {
	if (!existsSync(file)) return [];
	const out: RunLogEntry[] = [];
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as RunLogEntry;
			if (e && typeof e.at === "string" && Array.isArray(e.tools)) out.push(e);
		} catch {
			/* línea cortada (Aku se cerró al escribir): se salta */
		}
	}
	return out;
}

/** Las últimas respuestas, de la más nueva a la más vieja; con `sessionId`, solo las de ese chat. */
export function readRunLog(opts: { limit?: number; sessionId?: string } = {}): RunLogEntry[] {
	const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
	let all = [...readLines(oldFile()), ...readLines(currentFile())];
	if (opts.sessionId) all = all.filter((e) => e.sessionId === opts.sessionId);
	return all.slice(-limit).reverse();
}

/** Resumen para la cabecera del registro: cuántas respuestas, cuántas fallaron y las herramientas que más fallan. */
export function summarizeRuns(entries: RunLogEntry[]): { runs: number; failed: number; avgMs: number; failingTools: { name: string; failed: number; total: number }[] } {
	const failed = entries.filter((e) => e.outcome === "error" || e.outcome === "empty").length;
	const avgMs = entries.length ? Math.round(entries.reduce((s, e) => s + e.durationMs, 0) / entries.length) : 0;
	const byTool = new Map<string, { failed: number; total: number }>();
	for (const e of entries)
		for (const t of e.tools) {
			const c = byTool.get(t.name) ?? { failed: 0, total: 0 };
			c.total++;
			if (!t.ok) c.failed++;
			byTool.set(t.name, c);
		}
	const failingTools = [...byTool.entries()]
		.filter(([, c]) => c.failed > 0)
		.map(([name, c]) => ({ name, ...c }))
		.sort((a, b) => b.failed - a.failed)
		.slice(0, 5);
	return { runs: entries.length, failed, avgMs, failingTools };
}

/** Vacía el registro (botón «Borrar registro»). */
export function clearRunLog(): void {
	rmSync(currentFile(), { force: true });
	rmSync(oldFile(), { force: true });
}
