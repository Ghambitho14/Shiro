import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
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

function ensureDir(): void {
	if (!existsSync(DATA_DIR)) {
		mkdirSync(DATA_DIR, { recursive: true });
	}
}

function loadReminders(): Reminder[] {
	ensureDir();
	if (!existsSync(REMINDERS_FILE)) {
		return [];
	}
	try {
		const raw = readFileSync(REMINDERS_FILE, "utf-8");
		return JSON.parse(raw) as Reminder[];
	} catch {
		return [];
	}
}

function saveReminders(reminders: Reminder[]): void {
	ensureDir();
	writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), "utf-8");
}

function generateId(): string {
	return `rem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createReminder(data: {
	title: string;
	description?: string;
	datetime: string;
	repeat?: "daily" | "weekly" | "monthly" | "none";
}): Reminder {
	const reminders = loadReminders();
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
	saveReminders(reminders);
	return reminder;
}

export function getReminders(): Reminder[] {
	return loadReminders();
}

export function getActiveReminders(): Reminder[] {
	return loadReminders().filter((r) => r.active && !r.completed);
}

export function getReminderById(id: string): Reminder | undefined {
	return loadReminders().find((r) => r.id === id);
}

export function completeReminder(id: string): Reminder | null {
	const reminders = loadReminders();
	const idx = reminders.findIndex((r) => r.id === id);
	if (idx === -1) return null;
	
	const reminder = reminders[idx];
	reminder.completed = true;
	reminder.completedAt = new Date().toISOString();
	
	if (reminder.repeat && reminder.repeat !== "none") {
		const next = getNextReminderTime(reminder.datetime, reminder.repeat);
		const newReminder: Reminder = {
			id: generateId(),
			title: reminder.title,
			description: reminder.description,
			datetime: next,
			repeat: reminder.repeat,
			active: true,
			completed: false,
			createdAt: new Date().toISOString(),
		};
		reminders[idx] = reminder;
		reminders.push(newReminder);
	} else {
		reminder.active = false;
		reminders[idx] = reminder;
	}
	
	saveReminders(reminders);
	return reminder;
}

export function deleteReminder(id: string): boolean {
	const reminders = loadReminders();
	const idx = reminders.findIndex((r) => r.id === id);
	if (idx === -1) return false;
	reminders.splice(idx, 1);
	saveReminders(reminders);
	return true;
}

export function updateReminder(id: string, data: Partial<{ title: string; description: string; datetime: string; repeat: "daily" | "weekly" | "monthly" | "none"; active: boolean }>): Reminder | null {
	const reminders = loadReminders();
	const idx = reminders.findIndex((r) => r.id === id);
	if (idx === -1) return null;
	
	const reminder = { ...reminders[idx], ...data };
	reminders[idx] = reminder;
	saveReminders(reminders);
	return reminder;
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

export function getDueReminders(): Reminder[] {
	const now = new Date();
	return getActiveReminders().filter((r) => {
		const reminderDate = new Date(r.datetime);
		return reminderDate <= now;
	});
}

export function getUpcomingReminders(limit = 5): Reminder[] {
	const now = new Date();
	return getActiveReminders()
		.filter((r) => new Date(r.datetime) > now)
		.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime())
		.slice(0, limit);
}
