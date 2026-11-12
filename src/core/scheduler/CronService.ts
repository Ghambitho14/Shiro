/**
 * Tareas programadas (`data/cron-tasks.json`, siempre en este equipo).
 *
 * - Horario con `parseSchedule` (schedule.ts): intervalos o días y hora fija, con la hora del equipo.
 * - Un solo reloj revisa cada 30 s qué toca (`nextRun`). Si Aku estaba apagado a esa hora,
 *   al encenderse la tarea corre una vez (no todas las que se perdió) y sigue con la próxima.
 * - Acciones: `agent` (Aku hace lo pedido con herramientas de solo lectura y manda el resultado),
 *   `notify`/`reminder` (manda el mensaje tal cual) y `exec` (un comando aprobado al crearla).
 *   Lo hace `runTask.ts`; el resultado llega por la web, Telegram o ambos (`deliver`).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { describeSchedule, nextRunAfter, parseSchedule } from "./schedule.js";

const CRON_FILE = join(DATA_DIR, "cron-tasks.json");
const TICK_MS = 30_000;

export type CronAction = "agent" | "notify" | "reminder" | "exec";
export type CronDelivery = "web" | "telegram" | "both";
export const CRON_ACTIONS: CronAction[] = ["agent", "notify", "reminder", "exec"];
export const CRON_DELIVERIES: CronDelivery[] = ["web", "telegram", "both"];

export interface CronTask {
	id: string;
	name: string;
	/** El horario tal como se escribió («lunes a viernes 9:30»). */
	expression: string;
	action: CronAction;
	/** `prompt` (agent), `message` (notify/reminder), `command` (exec). */
	payload: Record<string, unknown>;
	/** Por dónde llega el resultado. Las tareas de antes no lo tienen: `both`. */
	deliver?: CronDelivery;
	/** Proyecto en el que trabaja la tarea `agent` (sus archivos se leen con la tool project). */
	projectId?: string;
	enabled: boolean;
	lastRun?: string;
	nextRun?: string;
	/** Lo último que mandó (recortado) y el último error, para verlo en la web. */
	lastResult?: string;
	lastError?: string;
	createdAt: string;
}

export type CronRunner = (task: CronTask) => Promise<{ result?: string; error?: string }>;

let runner: CronRunner | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
/** Tareas en marcha: la misma no corre dos veces a la vez. */
const running = new Set<string>();

function loadTasks(): CronTask[] {
	if (!existsSync(CRON_FILE)) return [];
	try {
		const data = JSON.parse(readFileSync(CRON_FILE, "utf-8")) as unknown;
		return Array.isArray(data) ? (data as CronTask[]) : [];
	} catch {
		return [];
	}
}

function saveTasks(tasks: CronTask[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CRON_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

/** Cambia una tarea releyendo el archivo (otra parte pudo cambiar otras mientras tanto). */
function updateTask(id: string, change: (t: CronTask) => void): CronTask | undefined {
	const tasks = loadTasks();
	const task = tasks.find((t) => t.id === id);
	if (!task) return undefined;
	change(task);
	saveTasks(tasks);
	return task;
}

/** Próxima vez que toca, o undefined si el horario ya no se entiende. */
function computeNext(task: CronTask, from: Date): string | undefined {
	try {
		return nextRunAfter(parseSchedule(task.expression), from).toISOString();
	} catch {
		return undefined;
	}
}

export type NewCronTask = {
	name: string;
	expression: string;
	action: CronAction;
	payload: Record<string, unknown>;
	deliver?: CronDelivery;
	projectId?: string;
};

export function createCronTask(input: NewCronTask): CronTask {
	const name = input.name.trim();
	if (!name) throw new Error("Falta el nombre de la tarea.");
	const schedule = parseSchedule(input.expression); // lanza si no se entiende
	if (input.action === "agent" && !String(input.payload.prompt ?? "").trim()) {
		throw new Error("Falta qué tiene que hacer Aku (prompt).");
	}
	if (input.action === "exec" && !String(input.payload.command ?? "").trim()) throw new Error("Falta el comando.");
	if ((input.action === "notify" || input.action === "reminder") && !String(input.payload.message ?? "").trim()) {
		input.payload.message = name;
	}
	const now = new Date();
	const task: CronTask = {
		id: `cron_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
		name: name.slice(0, 120),
		expression: input.expression.trim(),
		action: input.action,
		payload: input.payload,
		deliver: input.deliver ?? "both",
		...(input.projectId ? { projectId: input.projectId } : {}),
		enabled: true,
		createdAt: now.toISOString(),
		nextRun: nextRunAfter(schedule, now).toISOString(),
	};
	const tasks = loadTasks();
	tasks.push(task);
	saveTasks(tasks);
	return task;
}

export function listCronTasks(): CronTask[] {
	return loadTasks();
}

export function getCronTask(id: string): CronTask | undefined {
	return loadTasks().find((t) => t.id === id);
}

/** El horario en palabras, o el texto tal cual si ya no se entiende. */
export function describeTaskSchedule(task: CronTask): string {
	try {
		return describeSchedule(parseSchedule(task.expression));
	} catch {
		return task.expression;
	}
}

export function deleteCronTask(id: string): boolean {
	const tasks = loadTasks();
	const index = tasks.findIndex((t) => t.id === id);
	if (index === -1) return false;
	tasks.splice(index, 1);
	saveTasks(tasks);
	return true;
}

export function toggleCronTask(id: string, enabled: boolean): CronTask | undefined {
	return updateTask(id, (t) => {
		t.enabled = enabled;
		// Al reanudar, desde ahora: no corre de golpe por lo que tocaba mientras estaba en pausa.
		if (enabled) t.nextRun = computeNext(t, new Date());
	});
}

/** Ejecuta la tarea ya (botón «Ejecutar ahora» o el reloj). No cambia `nextRun`. */
export async function runCronTask(id: string): Promise<CronTask> {
	const task = getCronTask(id);
	if (!task) throw new Error("No encontré esa tarea.");
	if (!runner) throw new Error("Las tareas programadas no están listas todavía.");
	if (running.has(id)) throw new Error("Esa tarea ya se está ejecutando.");
	running.add(id);
	try {
		updateTask(id, (t) => {
			t.lastRun = new Date().toISOString();
		});
		let outcome: { result?: string; error?: string };
		try {
			outcome = await runner(task);
		} catch (err) {
			outcome = { error: err instanceof Error ? err.message : String(err) };
		}
		const saved = updateTask(id, (t) => {
			t.lastResult = outcome.result ? outcome.result.slice(0, 500) : t.lastResult;
			if (outcome.error) t.lastError = outcome.error.slice(0, 500);
			else delete t.lastError;
		});
		if (outcome.error) console.error(`[Tareas] «${task.name}»: ${outcome.error}`);
		return saved ?? task;
	} finally {
		running.delete(id);
	}
}

export function isCronTaskRunning(id: string): boolean {
	return running.has(id);
}

/** Una vuelta del reloj: corre lo que ya tocaba (una vez) y agenda la próxima. Devuelve los ids lanzados. */
export function runDueTasks(now = new Date()): string[] {
	const tasks = loadTasks();
	const due: string[] = [];
	let changed = false;
	for (const t of tasks) {
		if (!t.enabled) continue;
		if (!t.nextRun) {
			// Tareas de antes o con un horario que se volvió a entender: se agendan sin correr.
			const next = computeNext(t, now);
			if (next) {
				t.nextRun = next;
				changed = true;
			}
			continue;
		}
		if (new Date(t.nextRun).getTime() > now.getTime() || running.has(t.id)) continue;
		t.nextRun = computeNext(t, now);
		changed = true;
		due.push(t.id);
	}
	if (changed) saveTasks(tasks);
	for (const id of due) void runCronTask(id).catch((err) => console.error(`[Tareas] ${err instanceof Error ? err.message : err}`));
	return due;
}

/** Arranca el reloj. `run` es quien hace cada tarea (runTask.ts). */
export function initCronScheduler(run: CronRunner): void {
	runner = run;
	if (ticker) return;
	const count = loadTasks().filter((t) => t.enabled).length;
	if (count) console.log(`  [Tareas] ${count} tarea(s) programada(s) activa(s).`);
	runDueTasks();
	ticker = setInterval(() => runDueTasks(), TICK_MS);
	ticker.unref?.();
}

export function stopCronScheduler(): void {
	if (ticker) clearInterval(ticker);
	ticker = null;
}
