/**
 * Google Calendar de la cuenta conectada (`googleAuth.ts`): ver eventos y crearlos en el calendario principal.
 * Las horas sin zona se entienden en la zona horaria de este equipo.
 */
import { googleApi } from "./googleAuth.js";

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type GDate = { dateTime?: string; date?: string; timeZone?: string };
type GEvent = { id: string; summary?: string; location?: string; description?: string; start?: GDate; end?: GDate; htmlLink?: string; attendees?: { email: string }[]; organizer?: { email?: string } };

export type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string; attendees: string[]; link: string };

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function toEvent(e: GEvent): CalEvent {
	return {
		id: e.id,
		title: e.summary || "(sin título)",
		start: e.start?.dateTime ?? e.start?.date ?? "",
		end: e.end?.dateTime ?? e.end?.date ?? "",
		allDay: Boolean(e.start?.date && !e.start.dateTime),
		location: e.location ?? "",
		description: (e.description ?? "").slice(0, 1000),
		attendees: (e.attendees ?? []).map((a) => a.email),
		link: e.htmlLink ?? "",
	};
}

/**
 * Lee una fecha u hora: ISO («2026-11-20T15:00», con o sin zona) o solo el día («2026-11-20»).
 * Devuelve el formato que pide Google (`date` para todo el día, `dateTime` + zona del equipo para una hora).
 */
export function parseWhen(value: string): GDate {
	const v = value.trim().replace(" ", "T");
	if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v)) {
		throw new Error(`No entiendo la fecha «${value}». Usa el formato 2026-11-20T15:00 (o 2026-11-20 para todo el día).`);
	}
	const withSeconds = v.replace(/T(\d{2}:\d{2})(?=$|Z|[+-])/, "T$1:00");
	const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(withSeconds);
	return hasZone ? { dateTime: withSeconds } : { dateTime: withSeconds, timeZone: localTimeZone() };
}

/** Eventos entre dos momentos (por defecto, desde ahora hasta dentro de 7 días). */
export async function listEvents(opts: { from?: string; to?: string; query?: string; max?: number; signal?: AbortSignal } = {}): Promise<CalEvent[]> {
	const asInstant = (s: string | undefined, fallback: Date) => {
		if (!s?.trim()) return fallback.toISOString();
		const w = parseWhen(s);
		const d = new Date(w.date ? `${w.date}T00:00:00` : w.dateTime!);
		if (Number.isNaN(d.getTime())) throw new Error(`No entiendo la fecha «${s}».`);
		return d.toISOString();
	};
	const from = asInstant(opts.from, new Date());
	const to = asInstant(opts.to, new Date(Date.parse(from) + 7 * 86_400_000));
	const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: String(Math.max(1, Math.min(50, opts.max ?? 20))), timeZone: localTimeZone() });
	if (opts.query?.trim()) q.set("q", opts.query.trim());
	const data = await googleApi<{ items?: GEvent[] }>(`${API}?${q}`, { signal: opts.signal });
	return (data.items ?? []).map(toEvent);
}

export type NewEvent = { title: string; start: string; end?: string; location?: string; description?: string; attendees?: string[] };

/** El evento como lo pide Google. Sin fin: una hora después (o el mismo día si es de día completo). */
export function buildEvent(e: NewEvent): Record<string, unknown> {
	const start = parseWhen(e.start);
	let end: GDate;
	if (e.end?.trim()) end = parseWhen(e.end);
	else if (start.date) {
		const d = new Date(`${start.date}T12:00:00Z`);
		d.setUTCDate(d.getUTCDate() + 1);
		end = { date: d.toISOString().slice(0, 10) };
	} else {
		// Una hora después, con la misma forma (y zona) que el inicio.
		const [, date, hh, rest] = /^(\d{4}-\d{2}-\d{2})T(\d{2})(.*)$/.exec(start.dateTime!)!;
		const h = Number(hh) + 1;
		if (h < 24) end = { ...start, dateTime: `${date}T${String(h).padStart(2, "0")}${rest}` };
		else {
			const d = new Date(`${date}T12:00:00Z`);
			d.setUTCDate(d.getUTCDate() + 1);
			end = { ...start, dateTime: `${d.toISOString().slice(0, 10)}T00${rest}` };
		}
	}
	if (Boolean(start.date) !== Boolean(end.date)) throw new Error("El inicio y el fin tienen que ser los dos de día completo o los dos con hora.");
	return {
		summary: e.title,
		...(e.location ? { location: e.location } : {}),
		...(e.description ? { description: e.description } : {}),
		start,
		end,
		...(e.attendees?.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
	};
}

export async function createEvent(e: NewEvent, signal?: AbortSignal): Promise<CalEvent> {
	// Con invitados, Google les manda la invitación por correo.
	const q = e.attendees?.length ? "?sendUpdates=all" : "";
	return toEvent(await googleApi<GEvent>(`${API}${q}`, { method: "POST", body: buildEvent(e), signal }));
}
