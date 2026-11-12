/**
 * email y calendar: el Gmail y el Google Calendar de la cuenta conectada en Ajustes → Conexiones.
 * Leer no pide permiso; enviar un correo y crear un evento piden permiso siempre (`approval.ts`).
 * Preparar un borrador no envía nada: queda en Borradores de Gmail.
 */
import { currentAgentRun, currentResultBudget } from "../../agent/runContext.js";
import { createEvent, listEvents, localTimeZone } from "../../google/calendar.js";
import { draftMail, readMail, searchMail, sendMail, type MailFull } from "../../google/gmail.js";
import { sliceText } from "../textSlice.js";

type Result = { ok: boolean; content: string };
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fail = (err: unknown): Result => ({ ok: false, content: err instanceof Error ? err.message : String(err) });

export async function executeEmail(args: Record<string, unknown>): Promise<Result> {
	const signal = currentAgentRun()?.signal;
	const action = str(args.action) || "search";
	try {
		switch (action) {
			case "search": {
				const query = str(args.query);
				const found = await searchMail(query, typeof args.max === "number" ? args.max : 10, signal);
				if (!found.length) return { ok: true, content: `No hay correos${query ? ` para «${query}»` : " en la bandeja de entrada"}.` };
				const lines = found.map((m) => `- [${m.id}] ${m.unread ? "(sin leer) " : ""}${m.date}\n  De: ${m.from}\n  Asunto: ${m.subject}\n  ${m.snippet}`);
				return { ok: true, content: `${found.length} correos${query ? ` para «${query}»` : ""} (lee uno con action=read e id):\n${lines.join("\n")}` };
			}
			case "read": {
				const id = str(args.id);
				if (!id) return { ok: false, content: "Indica el id del correo (lo da action=search)." };
				const m = await readMail(id, signal);
				const head = `De: ${m.from}\nPara: ${m.to}${m.cc ? `\nCC: ${m.cc}` : ""}\nFecha: ${m.date}\nAsunto: ${m.subject}${m.attachments.length ? `\nAdjuntos: ${m.attachments.join(", ")}` : ""}\n\n`;
				const s = sliceText(head + (m.body || "(sin texto)"), { offset: typeof args.offset === "number" ? args.offset : undefined, maxChars: currentResultBudget() - 300 });
				return { ok: true, content: `${s.body}${s.note}` };
			}
			case "send":
			case "draft": {
				const replyId = str(args.reply_to_id);
				let replyTo: MailFull | undefined;
				if (replyId) replyTo = await readMail(replyId, signal);
				const to = str(args.to) || (replyTo ? replyTo.from : "");
				const subject = str(args.subject) || replyTo?.subject || "";
				const body = typeof args.body === "string" ? args.body : "";
				if (!to) return { ok: false, content: "Falta a quién (to)." };
				if (!body.trim()) return { ok: false, content: "Falta el texto del correo (body)." };
				const mail = { to, cc: str(args.cc) || undefined, subject, body, replyTo };
				if (action === "draft") {
					await draftMail(mail, signal);
					return { ok: true, content: `Borrador guardado en Gmail para ${to} («${subject || "sin asunto"}»). No se envió.` };
				}
				await sendMail(mail, signal);
				return { ok: true, content: `Correo enviado a ${to} («${subject || "sin asunto"}»).` };
			}
			default:
				return { ok: false, content: `Acción desconocida: ${action}. Usa search, read, draft o send.` };
		}
	} catch (err) {
		return fail(err);
	}
}

const when = (iso: string, allDay: boolean) => {
	if (allDay) return `${iso} (todo el día)`;
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: localTimeZone() });
};

export async function executeCalendar(args: Record<string, unknown>): Promise<Result> {
	const signal = currentAgentRun()?.signal;
	const action = str(args.action) || "list";
	try {
		switch (action) {
			case "list": {
				const events = await listEvents({ from: str(args.from), to: str(args.to), query: str(args.query), max: typeof args.max === "number" ? args.max : undefined, signal });
				if (!events.length) return { ok: true, content: "No hay eventos en esas fechas." };
				const lines = events.map(
					(e) =>
						`- ${when(e.start, e.allDay)}${e.allDay ? "" : ` → ${when(e.end, false)}`}: ${e.title}${e.location ? ` (${e.location})` : ""}${e.attendees.length ? `\n  Con: ${e.attendees.join(", ")}` : ""}${e.description ? `\n  ${e.description.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
				);
				return { ok: true, content: `Eventos (hora de ${localTimeZone()}):\n${lines.join("\n")}` };
			}
			case "create": {
				const title = str(args.title);
				const start = str(args.start);
				if (!title || !start) return { ok: false, content: "Faltan el título (title) y el inicio (start, p. ej. 2026-11-20T15:00)." };
				const attendees = Array.isArray(args.attendees) ? args.attendees.map(String) : [];
				const e = await createEvent({ title, start, end: str(args.end) || undefined, location: str(args.location) || undefined, description: str(args.description) || undefined, attendees }, signal);
				return { ok: true, content: `Evento creado: ${e.title}, ${when(e.start, e.allDay)}${attendees.length ? `; invitación enviada a ${attendees.join(", ")}` : ""}. ${e.link}` };
			}
			default:
				return { ok: false, content: `Acción desconocida: ${action}. Usa list o create.` };
		}
	} catch (err) {
		return fail(err);
	}
}
