import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "data");
const CRON_FILE = join(DATA_DIR, "cron-tasks.json");

export interface CronTask {
	id: string;
	name: string;
	expression: string;
	action: "notify" | "exec" | "reminder";
	payload: Record<string, unknown>;
	enabled: boolean;
	lastRun?: string;
	nextRun?: string;
	createdAt: string;
}

function loadTasks(): CronTask[] {
	if (!existsSync(CRON_FILE)) return [];
	try {
		const data = readFileSync(CRON_FILE, "utf-8");
		return JSON.parse(data) as CronTask[];
	} catch {
		return [];
	}
}

function saveTasks(tasks: CronTask[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CRON_FILE, JSON.stringify(tasks, null, 2), "utf-8");
}

function parseCronExpression(expression: string): { interval: number; unit: string } {
	const parts = expression.toLowerCase().split(" ");
	if (parts.length !== 2) {
		throw new Error("Formato inválido. Usa: '<numero> <minutos|horas|días>'");
	}
	
	const value = parseInt(parts[0], 10);
	const unit = parts[1];
	
	if (isNaN(value) || value <= 0) {
		throw new Error("El número debe ser positivo");
	}
	
	const multipliers: Record<string, number> = {
		minuto: 60 * 1000,
		minutos: 60 * 1000,
		hora: 60 * 60 * 1000,
		horas: 60 * 60 * 1000,
		día: 24 * 60 * 60 * 1000,
		dias: 24 * 60 * 60 * 1000,
		day: 24 * 60 * 60 * 1000,
		days: 24 * 60 * 60 * 1000,
		hour: 60 * 60 * 1000,
		hours: 60 * 60 * 1000,
		minute: 60 * 1000,
		minutes: 60 * 1000,
	};
	
	if (!multipliers[unit]) {
		throw new Error("Unidad inválida. Usa: minutos, horas, días");
	}
	
	return { interval: value * multipliers[unit], unit };
}

export function createCronTask(
	name: string,
	expression: string,
	action: "notify" | "exec" | "reminder",
	payload: Record<string, unknown>,
): CronTask {
	const tasks = loadTasks();
	const { interval } = parseCronExpression(expression);
	
	const task: CronTask = {
		id: `cron_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		name,
		expression,
		action,
		payload,
		enabled: true,
		createdAt: new Date().toISOString(),
		nextRun: new Date(Date.now() + interval).toISOString(),
	};
	
	tasks.push(task);
	saveTasks(tasks);
	
	scheduleTask(task);
	
	return task;
}

export function listCronTasks(): CronTask[] {
	return loadTasks();
}

export function getCronTask(id: string): CronTask | undefined {
	const tasks = loadTasks();
	return tasks.find(t => t.id === id);
}

export function deleteCronTask(id: string): boolean {
	const tasks = loadTasks();
	const index = tasks.findIndex(t => t.id === id);
	
	if (index === -1) return false;
	
	tasks.splice(index, 1);
	saveTasks(tasks);
	
	return true;
}

export function toggleCronTask(id: string, enabled: boolean): CronTask | undefined {
	const tasks = loadTasks();
	const task = tasks.find(t => t.id === id);
	
	if (!task) return undefined;
	
	task.enabled = enabled;
	saveTasks(tasks);
	
	if (enabled) {
		scheduleTask(task);
	}
	
	return task;
}

const scheduledTimeouts = new Map<string, NodeJS.Timeout>();

function scheduleTask(task: CronTask): void {
	if (!task.enabled) return;
	
	const existing = scheduledTimeouts.get(task.id);
	if (existing) {
		clearTimeout(existing);
	}
	
	const { interval } = parseCronExpression(task.expression);
	
	const timeout = setInterval(async () => {
		task.lastRun = new Date().toISOString();
		task.nextRun = new Date(Date.now() + interval).toISOString();
		saveTasks(loadTasks().map(t => t.id === task.id ? task : t));
		
		await executeTask(task);
	}, interval);
	
	scheduledTimeouts.set(task.id, timeout);
}

async function executeTask(task: CronTask): Promise<void> {
	console.log(`[Cron] Ejecutando: ${task.name} (${task.action})`);
	
	switch (task.action) {
		case "exec":
			if (task.payload.command) {
				const { exec } = await import("node:child_process");
				exec(task.payload.command as string, (error, stdout, stderr) => {
					if (error) {
						console.error(`[Cron] Error en ${task.name}:`, error.message);
					} else {
						console.log(`[Cron] Output de ${task.name}:`, stdout.slice(0, 200));
					}
				});
			}
			break;
			
		case "reminder":
		case "notify":
			console.log(`[Cron] Notificación: ${task.payload.message || task.name}`);
			break;
	}
}

export function initCronScheduler(): void {
	const tasks = loadTasks();
	console.log(`[Cron] Inicializando ${tasks.length} tareas programadas`);
	
	for (const task of tasks) {
		if (task.enabled) {
			scheduleTask(task);
		}
	}
}

export function stopCronScheduler(): void {
	for (const [id, timeout] of scheduledTimeouts) {
		clearInterval(timeout);
	}
	scheduledTimeouts.clear();
	console.log("[Cron] Scheduler detenido");
}