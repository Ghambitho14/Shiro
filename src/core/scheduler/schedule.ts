/**
 * Horarios de las tareas programadas, escritos como los diría una persona:
 * - Intervalo: «30 minutos», «cada 2 horas», «1 día», «cada hora».
 * - Hora fija: «cada día 08:00», «todos los días a las 8», «lunes a viernes 9:30»,
 *   «viernes 18:00», «lunes y jueves a las 7 pm», «fines de semana 10:00».
 * La hora es la del equipo donde corre Aku.
 */

export type Schedule =
	| { kind: "interval"; ms: number }
	/** `days`: 0 = domingo … 6 = sábado, ordenados y sin repetir. */
	| { kind: "weekly"; days: number[]; hour: number; minute: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS: Record<string, number> = {
	minuto: MINUTE,
	minutos: MINUTE,
	min: MINUTE,
	mins: MINUTE,
	minute: MINUTE,
	minutes: MINUTE,
	hora: HOUR,
	horas: HOUR,
	h: HOUR,
	hour: HOUR,
	hours: HOUR,
	dia: DAY,
	dias: DAY,
	day: DAY,
	days: DAY,
	semana: 7 * DAY,
	semanas: 7 * DAY,
	week: 7 * DAY,
	weeks: 7 * DAY,
};

const DAY_NAMES: [RegExp, number][] = [
	[/\b(domingos?|sunday|sun)\b/, 0],
	[/\b(lunes|monday|mon)\b/, 1],
	[/\b(martes|tuesday|tue)\b/, 2],
	[/\b(miercoles|wednesday|wed)\b/, 3],
	[/\b(jueves|thursday|thu)\b/, 4],
	[/\b(viernes|friday|fri)\b/, 5],
	[/\b(sabados?|saturday|sat)\b/, 6],
];

const WEEKDAY_LABELS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Sin tildes, en minúsculas y con espacios simples. */
function normalize(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

const HELP =
	'Escribe el horario como «cada día 08:00», «lunes a viernes 9:30», «viernes a las 18:00» o «cada 2 horas».';

function parseTime(text: string): { hour: number; minute: number } | null {
	// 08:00, 8.30, 8h30, 18:00 hrs, 7:15 pm
	let m = /\b(\d{1,2})\s*(?::|\.|h)\s*(\d{2})\s*(am|pm|a\.?m\.?|p\.?m\.?)?/.exec(text);
	// a las 8, a las 7 pm, 7pm, 8 de la mañana / tarde / noche
	if (!m) m = /\b(?:a las?|alas)\s*(\d{1,2})()\s*(am|pm|a\.?m\.?|p\.?m\.?)?/.exec(text);
	if (!m) m = /\b(\d{1,2})()\s*(am|pm|a\.?m\.?|p\.?m\.?)/.exec(text);
	if (!m) return null;
	let hour = Number(m[1]);
	const minute = m[2] ? Number(m[2]) : 0;
	const suffix = (m[3] ?? "").replace(/\./g, "");
	const after = text.slice(m.index + m[0].length);
	const pm = suffix === "pm" || (!suffix && /^\s*(de la )?(tarde|noche)\b/.test(after));
	if (pm && hour < 12) hour += 12;
	if (suffix === "am" && hour === 12) hour = 0;
	if (hour > 23 || minute > 59) return null;
	return { hour, minute };
}

function parseDays(text: string): number[] | null {
	if (/\b(dias? (de semana|habiles|laborables)|entre semana|weekdays?)\b/.test(text)) return [1, 2, 3, 4, 5];
	if (/\b(fines? de semana|weekends?)\b/.test(text)) return [0, 6];
	if (/\b(todos los dias|cada dia|diari\w*|daily|every day)\b/.test(text)) return [0, 1, 2, 3, 4, 5, 6];
	// «lunes a viernes»: rango (puede dar la vuelta: «viernes a lunes»).
	const names = DAY_NAMES.map(([re]) => re.source.replace(/^\\b\(|\)\\b$/g, "")).join("|");
	const range = new RegExp(`\\b(${names})\\b\\s*(?:a|al|hasta|-)\\s*\\b(${names})\\b`).exec(text);
	if (range) {
		const from = dayIndex(range[1]);
		const to = dayIndex(range[2]);
		if (from !== null && to !== null) {
			const days: number[] = [];
			for (let d = from; ; d = (d + 1) % 7) {
				days.push(d);
				if (d === to) break;
			}
			return [...new Set(days)].sort((a, b) => a - b);
		}
	}
	const found = DAY_NAMES.filter(([re]) => re.test(text)).map(([, d]) => d);
	return found.length ? found.sort((a, b) => a - b) : null;
}

function dayIndex(word: string): number | null {
	for (const [re, d] of DAY_NAMES) if (re.test(word)) return d;
	return null;
}

/** Entiende el horario o lanza un error en español que dice cómo escribirlo. */
export function parseSchedule(expression: string): Schedule {
	const text = normalize(expression);
	if (!text) throw new Error(`Falta el horario. ${HELP}`);

	// Intervalo: «2 horas», «cada 30 minutos», «cada hora».
	const interval = /^(?:cada\s+)?(\d+)?\s*([a-z]+)$/.exec(text);
	if (interval && UNITS[interval[2]] !== undefined) {
		const value = interval[1] ? Number(interval[1]) : 1;
		if (!Number.isFinite(value) || value <= 0) throw new Error(`El número tiene que ser mayor que cero. ${HELP}`);
		const ms = value * UNITS[interval[2]];
		if (ms < 5 * MINUTE) throw new Error("Lo mínimo es cada 5 minutos.");
		return { kind: "interval", ms };
	}

	const time = parseTime(text);
	if (!time) throw new Error(`No entendí el horario «${expression}». ${HELP}`);
	const days = parseDays(text) ?? [0, 1, 2, 3, 4, 5, 6];
	return { kind: "weekly", days, ...time };
}

/** La próxima vez que toca después de `from` (nunca la misma hora: siempre más tarde). */
export function nextRunAfter(schedule: Schedule, from: Date): Date {
	if (schedule.kind === "interval") return new Date(from.getTime() + schedule.ms);
	for (let offset = 0; offset <= 7; offset++) {
		const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, schedule.hour, schedule.minute, 0, 0);
		if (candidate.getTime() > from.getTime() && schedule.days.includes(candidate.getDay())) return candidate;
	}
	// No debería pasar (siempre hay al menos un día); por si acaso, mañana a esa hora.
	return new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, schedule.hour, schedule.minute);
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function formatInterval(ms: number): string {
	const units: [number, string, string][] = [
		[7 * DAY, "semana", "semanas"],
		[DAY, "día", "días"],
		[HOUR, "hora", "horas"],
		[MINUTE, "minuto", "minutos"],
	];
	for (const [size, one, many] of units) {
		if (ms % size === 0) {
			const n = ms / size;
			return n === 1 ? `cada ${one}` : `cada ${n} ${many}`;
		}
	}
	return `cada ${Math.round(ms / MINUTE)} minutos`;
}

/** El horario en palabras: «todos los días a las 08:00», «de lunes a viernes a las 09:30». */
export function describeSchedule(schedule: Schedule): string {
	if (schedule.kind === "interval") return formatInterval(schedule.ms);
	const at = `a las ${pad(schedule.hour)}:${pad(schedule.minute)}`;
	const d = schedule.days;
	if (d.length === 7) return `todos los días ${at}`;
	if (d.join() === "1,2,3,4,5") return `de lunes a viernes ${at}`;
	if (d.join() === "0,6") return `los fines de semana ${at}`;
	// Lunes primero, domingo al final.
	const ordered = [...d].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((x) => WEEKDAY_LABELS[x]);
	const list = ordered.length === 1 ? ordered[0] : `${ordered.slice(0, -1).join(", ")} y ${ordered[ordered.length - 1]}`;
	return `los ${list} ${at}`;
}
