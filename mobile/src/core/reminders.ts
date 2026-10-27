/**
 * Recordatorios en Supabase (tabla shiro_reminders, una fila por recordatorio con el JSON en `data`),
 * los mismos que ve y avisa Shiro del PC (src/core/reminders/reminders.ts).
 */
import { sbRequest, type SupabaseConn } from "./supabase";

export type Repeat = "daily" | "weekly" | "monthly" | "none";

export type Reminder = {
	id: string;
	title: string;
	description?: string;
	datetime: string;
	repeat?: Repeat;
	active: boolean;
	completed: boolean;
	createdAt: string;
	completedAt?: string;
};

export const REPEAT_LABELS: Record<Repeat, string> = { none: "Una vez", daily: "Cada día", weekly: "Cada semana", monthly: "Cada mes" };

const newReminderId = () => `rem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const eq = (v: string) => `eq.${encodeURIComponent(v)}`;

const UNITS: Record<string, number> = {
	s: 1000, seg: 1000, segundo: 1000, segundos: 1000, second: 1000, seconds: 1000,
	m: 60_000, min: 60_000, mins: 60_000, minuto: 60_000, minutos: 60_000, minute: 60_000, minutes: 60_000,
	h: 3_600_000, hora: 3_600_000, horas: 3_600_000, hour: 3_600_000, hours: 3_600_000,
	d: 86_400_000, dia: 86_400_000, dias: 86_400_000, day: 86_400_000, days: 86_400_000,
	semana: 604_800_000, semanas: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

/**
 * Convierte lo que da el modelo o el usuario en una fecha ISO: una fecha ISO, «in 30 minutes»,
 * «en 2 horas», «mañana a las 9», «hoy 18:30», «21:00». null si no se entiende.
 */
export function parseWhen(input: string, now = new Date()): string | null {
	const raw = input.trim();
	if (!raw) return null;
	const text = raw.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
	const rel = /^(?:in|en|dentro de)\s+(\d+(?:[.,]\d+)?)\s*([a-z]+)$/.exec(text);
	if (rel && UNITS[rel[2]]) return new Date(now.getTime() + Number(rel[1].replace(",", ".")) * UNITS[rel[2]]).toISOString();
	const day = /^(hoy|today|manana|tomorrow|pasado manana)?\s*(?:a las|at|,)?\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?$/.exec(text);
	if (day && (day[1] || day[3] || day[4] || /a las|at/.test(text))) {
		let hour = Number(day[2]);
		const minute = Number(day[3] ?? 0);
		if (day[4] === "pm" && hour < 12) hour += 12;
		if (day[4] === "am" && hour === 12) hour = 0;
		if (hour > 23 || minute > 59) return null;
		const d = new Date(now);
		d.setSeconds(0, 0);
		d.setHours(hour, minute);
		const addDays = day[1] === "manana" || day[1] === "tomorrow" ? 1 : day[1] === "pasado manana" ? 2 : 0;
		d.setDate(d.getDate() + addDays);
		// «a las 9» sin día y ya pasó: mañana.
		if (!day[1] && d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
		return d.toISOString();
	}
	if (/^\d+$/.test(raw)) return null;
	const parsed = new Date(raw);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function nextTime(current: string, repeat: Exclude<Repeat, "none">): string {
	const d = new Date(current);
	if (repeat === "daily") d.setDate(d.getDate() + 1);
	else if (repeat === "weekly") d.setDate(d.getDate() + 7);
	else d.setMonth(d.getMonth() + 1);
	return d.toISOString();
}

export async function listReminders(conn: SupabaseConn): Promise<Reminder[]> {
	const rows = await sbRequest<{ data: Reminder }[]>(conn, "GET", "shiro_reminders?select=data");
	return rows
		.map((r) => r.data)
		.filter((r) => r && typeof r.id === "string")
		.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
}

async function save(conn: SupabaseConn, reminders: Reminder[]): Promise<void> {
	if (!reminders.length) return;
	const now = new Date().toISOString();
	await sbRequest(conn, "POST", "shiro_reminders?on_conflict=id", {
		body: reminders.map((r) => ({ id: r.id, data: r, updated_at: now })),
		prefer: "resolution=merge-duplicates,return=minimal",
	});
}

export async function createReminder(conn: SupabaseConn, input: { title: string; datetime: string; description?: string; repeat?: string }, now = new Date()): Promise<Reminder> {
	const title = input.title.trim();
	if (!title) throw new Error("Falta el título del recordatorio.");
	const when = parseWhen(input.datetime, now);
	if (!when) throw new Error(`No entiendo la fecha «${input.datetime}». Usa una fecha y hora (2026-10-27T18:00) o «en 30 minutos».`);
	const repeat: Repeat = ["daily", "weekly", "monthly"].includes(input.repeat ?? "") ? (input.repeat as Repeat) : "none";
	const reminder: Reminder = {
		id: newReminderId(),
		title,
		description: input.description?.trim() || undefined,
		datetime: when,
		repeat,
		active: true,
		completed: false,
		createdAt: now.toISOString(),
	};
	await save(conn, [reminder]);
	return reminder;
}

/** Hecho. Si se repite, se crea el siguiente (igual que en el PC). */
export async function completeReminder(conn: SupabaseConn, id: string): Promise<Reminder | null> {
	const all = await listReminders(conn);
	const r = all.find((x) => x.id === id);
	if (!r) return null;
	const done: Reminder = { ...r, completed: true, completedAt: new Date().toISOString(), active: r.repeat && r.repeat !== "none" ? r.active : false };
	const changes = [done];
	if (r.repeat && r.repeat !== "none") {
		changes.push({ ...r, id: newReminderId(), datetime: nextTime(r.datetime, r.repeat), active: true, completed: false, createdAt: new Date().toISOString(), completedAt: undefined });
	}
	await save(conn, changes);
	return done;
}

export async function deleteReminder(conn: SupabaseConn, id: string): Promise<void> {
	await sbRequest(conn, "DELETE", `shiro_reminders?id=${eq(id)}`);
}

export const isPending = (r: Reminder) => r.active && !r.completed;
