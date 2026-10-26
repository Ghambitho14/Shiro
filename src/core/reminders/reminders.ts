/**
 * Recordatorios, guardados donde diga Ajustes → Datos:
 * - local y obsidian: data/reminders.json (con Obsidian, además una lista legible en Shiro/Recordatorios.md)
 * - supabase: tabla shiro_reminders (una fila por recordatorio, en JSON)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { writeRemindersNote } from "../../storage/obsidian.js";
import { currentStorage, supabaseOf, vaultOf, type StorageSettings } from "../../storage/storage.js";
import { inList, supabaseRequest } from "../../storage/supabase.js";

const REMINDERS_FILE = join(DATA_DIR, "reminders.json");

export type Reminder = {
	id: string;
	title: string;
	description?: string;
	datetime: string;
	repeat?: "daily" | "weekly" | "monthly" | "none";
	active: boolean;
	completed: boolean;
	createdAt: string;
	completedAt?: string;
};

interface ReminderBackend {
	load(): Promise<Reminder[]>;
	/** Guarda la lista entera. `removed` son los ids borrados desde la última carga. */
	save(reminders: Reminder[], removed?: string[]): Promise<void>;
}

// ───────────────────────────── almacenes ─────────────────────────────

function loadLocal(): Reminder[] {
	if (!existsSync(REMINDERS_FILE)) return [];
	try {
		const data = JSON.parse(readFileSync(REMINDERS_FILE, "utf-8")) as unknown;
		return Array.isArray(data) ? (data as Reminder[]) : [];
	} catch {
		return [];
	}
}

function saveLocal(reminders: Reminder[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}

const localBackend: ReminderBackend = {
	async load() {
		return loadLocal();
	},
	async save(reminders) {
		saveLocal(reminders);
	},
};

function obsidianBackend(s: StorageSettings): ReminderBackend {
	return {
		load: localBackend.load,
		async save(reminders) {
			saveLocal(reminders);
			try {
				writeRemindersNote(vaultOf(s), reminders);
			} catch (err) {
				console.error(`[Obsidian] No pude actualizar Recordatorios.md: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}

/** La comprobación de recordatorios corre cada 5 s: con Supabase se relee como mucho cada 30 s. */
const SUPABASE_CACHE_MS = 30_000;
let supabaseCache: { key: string; at: number; reminders: Reminder[] } | null = null;

function supabaseBackend(s: StorageSettings): ReminderBackend {
	const cfg = supabaseOf(s);
	const cacheKey = `${cfg.url}|${cfg.key.slice(-8)}`;
	return {
		async load() {
			if (supabaseCache?.key === cacheKey && Date.now() - supabaseCache.at < SUPABASE_CACHE_MS) return structuredClone(supabaseCache.reminders);
			const rows = await supabaseRequest<{ data: Reminder }[]>(cfg, "GET", "shiro_reminders?select=data");
			const reminders = rows.map((r) => r.data).filter((r) => r && typeof r.id === "string");
			supabaseCache = { key: cacheKey, at: Date.now(), reminders };
			return structuredClone(reminders);
		},
		async save(reminders, removed = []) {
			supabaseCache = null;
			if (reminders.length) {
				const now = new Date().toISOString();
				await supabaseRequest(cfg, "POST", "shiro_reminders?on_conflict=id", {
					body: reminders.map((r) => ({ id: r.id, data: r, updated_at: now })),
					prefer: "resolution=merge-duplicates,return=minimal",
				});
			}
			if (removed.length) await supabaseRequest(cfg, "DELETE", `shiro_reminders?id=${inList(removed)}`);
		},
	};
}

export function reminderBackendFor(s: StorageSettings): ReminderBackend {
	if (s.kind === "supabase") return supabaseBackend(s);
	if (s.kind === "obsidian") return obsidianBackend(s);
	return localBackend;
}

const backend = () => reminderBackendFor(currentStorage());

// ───────────────────────────── API ─────────────────────────────

function generateId(): string {
	return `rem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function createReminder(data: {
	title: string;
	description?: string;
	datetime: string;
	repeat?: "daily" | "weekly" | "monthly" | "none";
}): Promise<Reminder> {
	const store = backend();
	const reminders = await store.load();
	const reminder: Reminder = {
		id: generateId(),
		title: data.title,
		description: data.description,
		datetime: data.datetime,
		repeat: data.repeat || "none",
		active: true,
		completed: false,
		createdAt: new Date().toISOString(),
	};
	reminders.push(reminder);
	await store.save(reminders);
	return reminder;
}

export async function getReminders(): Promise<Reminder[]> {
	return backend().load();
}

export async function getActiveReminders(): Promise<Reminder[]> {
	return (await backend().load()).filter((r) => r.active && !r.completed);
}

export async function getReminderById(id: string): Promise<Reminder | undefined> {
	return (await backend().load()).find((r) => r.id === id);
}

export async function completeReminder(id: string): Promise<Reminder | null> {
	const store = backend();
	const reminders = await store.load();
	const idx = reminders.findIndex((r) => r.id === id);
	if (idx === -1) return null;

	const reminder = reminders[idx];
	reminder.completed = true;
	reminder.completedAt = new Date().toISOString();

	if (reminder.repeat && reminder.repeat !== "none") {
		reminders.push({
			id: generateId(),
			title: reminder.title,
			description: reminder.description,
			datetime: getNextReminderTime(reminder.datetime, reminder.repeat),
			repeat: reminder.repeat,
			active: true,
			completed: false,
			createdAt: new Date().toISOString(),
		});
	} else {
		reminder.active = false;
	}

	await store.save(reminders);
	return reminder;
}

export async function deleteReminder(id: string): Promise<boolean> {
	const store = backend();
	const reminders = await store.load();
	const idx = reminders.findIndex((r) => r.id === id);
	if (idx === -1) return false;
	reminders.splice(idx, 1);
	await store.save(reminders, [id]);
	return true;
}

function getNextReminderTime(current: string, repeat: "daily" | "weekly" | "monthly"): string {
	const date = new Date(current);
	switch (repeat) {
		case "daily":
			date.setDate(date.getDate() + 1);
			break;
		case "weekly":
			date.setDate(date.getDate() + 7);
			break;
		case "monthly":
			date.setMonth(date.getMonth() + 1);
			break;
	}
	return date.toISOString();
}

export async function getDueReminders(): Promise<Reminder[]> {
	const now = new Date();
	return (await getActiveReminders()).filter((r) => new Date(r.datetime) <= now);
}

