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
	/** `reasoning`: tokens de pensar (parte de `output`); falta en registros de antes. */
	usage: { input: number; output: number; reasoning?: number; turns: number };
	outcome: RunOutcome;
	error?: string;
	/** Milisegundos hasta la primera palabra visible (solo con streaming). */
	firstTextMs?: number;
	/** ≈ Dólares de la respuesta (pricing.ts); `plan`: de una suscripción, no se pagan por token. */
	cost?: number;
	plan?: true;
	/** Respaldo entre motores: el modelo que no respondió y por eso contestó este. */
	fallbackFrom?: string;
};

/** Lo que la interfaz enseña de una respuesta además de los tokens: primera palabra y coste. */
export type ResponseStats = Pick<RunLogEntry, "firstTextMs" | "cost" | "plan">;

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

/** Cómo le fue a un modelo en las respuestas del registro (medias por respuesta). */
export type ModelSummary = {
	provider: string;
	model: string;
	runs: number;
	failed: number;
	avgMs: number;
	avgInput: number;
	avgOutput: number;
	avgReasoning: number;
	/** Media hasta la primera palabra (solo respuestas con streaming); falta si ninguna la midió. */
	avgFirstTextMs?: number;
	/** ≈ Dólares sumando todas sus respuestas (también las detenidas: se pagan igual); falta si no tiene precio. */
	cost?: number;
	/** De una suscripción: el coste es orientativo. */
	plan?: true;
};

/** Cómo le fue a una herramienta: cuántas veces se usó, cuántas falló y cuánto tarda de media. */
export type ToolSummary = { name: string; uses: number; failed: number; avgMs: number };

export type RunSummary = {
	runs: number;
	failed: number;
	avgMs: number;
	failingTools: { name: string; failed: number; total: number }[];
	/** Por modelo, de más a menos respuestas. */
	byModel: ModelSummary[];
	/** Por herramienta, de más a menos usada. */
	byTool: ToolSummary[];
	/** ≈ Dólares de todas las respuestas que pagan por token (sin las de suscripción). */
	totalCost: number;
};

const isFailure = (e: RunLogEntry) => e.outcome === "error" || e.outcome === "empty";
const avg = (total: number, n: number) => (n ? Math.round(total / n) : 0);
const roundUsd = (usd: number) => Math.round(usd * 1e6) / 1e6;

/**
 * Resumen para Ajustes → Registro: cuántas respuestas, cuántas fallaron, las herramientas que más fallan y
 * dos tablas para comparar («qué modelo y qué herramienta va mejor»). Las medias de tiempo y tokens son por
 * respuesta; las detenidas por el usuario no cuentan para el tiempo ni para los tokens (a medias, engañan).
 */
export function summarizeRuns(entries: RunLogEntry[]): RunSummary {
	const failed = entries.filter(isFailure).length;
	const avgMs = avg(entries.reduce((s, e) => s + e.durationMs, 0), entries.length);

	const models = new Map<string, { provider: string; model: string; runs: number; failed: number; measured: number; ms: number; input: number; output: number; reasoning: number; firstN: number; firstMs: number; cost?: number; plan?: true }>();
	let totalCost = 0;
	const tools = new Map<string, { uses: number; failed: number; ms: number }>();
	for (const e of entries) {
		const provider = e.provider || "?";
		const model = e.model || "?";
		const key = `${provider}|${model}`;
		const m = models.get(key) ?? { provider, model, runs: 0, failed: 0, measured: 0, ms: 0, input: 0, output: 0, reasoning: 0, firstN: 0, firstMs: 0 };
		if (typeof e.cost === "number") {
			m.cost = (m.cost ?? 0) + e.cost;
			if (e.plan) m.plan = true;
			else totalCost += e.cost;
		}
		m.runs++;
		if (isFailure(e)) m.failed++;
		if (e.outcome !== "cancelled") {
			m.measured++;
			m.ms += e.durationMs;
			m.input += e.usage?.input ?? 0;
			m.output += e.usage?.output ?? 0;
			m.reasoning += e.usage?.reasoning ?? 0;
			if (typeof e.firstTextMs === "number") {
				m.firstN++;
				m.firstMs += e.firstTextMs;
			}
		}
		models.set(key, m);
		for (const t of e.tools) {
			const c = tools.get(t.name) ?? { uses: 0, failed: 0, ms: 0 };
			c.uses++;
			c.ms += t.ms;
			if (!t.ok) c.failed++;
			tools.set(t.name, c);
		}
	}

	const byModel = [...models.values()]
		.map((m) => ({
			provider: m.provider,
			model: m.model,
			runs: m.runs,
			failed: m.failed,
			avgMs: avg(m.ms, m.measured),
			avgInput: avg(m.input, m.measured),
			avgOutput: avg(m.output, m.measured),
			avgReasoning: avg(m.reasoning, m.measured),
			...(m.firstN ? { avgFirstTextMs: avg(m.firstMs, m.firstN) } : {}),
			...(m.cost !== undefined ? { cost: roundUsd(m.cost) } : {}),
			...(m.plan ? { plan: true as const } : {}),
		}))
		.sort((a, b) => b.runs - a.runs);
	const byTool = [...tools.entries()].map(([name, c]) => ({ name, uses: c.uses, failed: c.failed, avgMs: avg(c.ms, c.uses) })).sort((a, b) => b.uses - a.uses);
	const failingTools = byTool
		.filter((t) => t.failed > 0)
		.map((t) => ({ name: t.name, failed: t.failed, total: t.uses }))
		.sort((a, b) => b.failed - a.failed)
		.slice(0, 5);
	return { runs: entries.length, failed, avgMs, failingTools, byModel, byTool, totalCost: roundUsd(totalCost) };
}

/** Vacía el registro (botón «Borrar registro»). */
export function clearRunLog(): void {
	rmSync(currentFile(), { force: true });
	rmSync(oldFile(), { force: true });
}
