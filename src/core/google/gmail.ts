/**
 * Gmail de la cuenta conectada (`googleAuth.ts`): buscar, leer, preparar borradores y enviar.
 * Lo que traen los correos lo escribió otra persona: la tool `email` es «contenido externo» (`untrusted.ts`).
 */
import { htmlToText } from "../tools/modules/fetch.js";
import { googleApi } from "./googleAuth.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: Part[]; headers?: Header[] };
type Message = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: Part; internalDate?: string };

export type MailSummary = { id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string; unread: boolean };
export type MailFull = MailSummary & { cc: string; messageId: string; references: string; body: string; attachments: string[] };

const header = (p: Part | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decode = (data?: string) => (data ? Buffer.from(data, "base64url").toString("utf-8") : "");

function summary(m: Message): MailSummary {
	return {
		id: m.id,
		threadId: m.threadId,
		from: header(m.payload, "From"),
		to: header(m.payload, "To"),
		subject: header(m.payload, "Subject") || "(sin asunto)",
		date: header(m.payload, "Date"),
		snippet: (m.snippet ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
		unread: m.labelIds?.includes("UNREAD") ?? false,
	};
}

/** Busca con la sintaxis de Gmail («from:ana is:unread newer_than:2d»). Sin texto: lo último de la bandeja de entrada. */
export async function searchMail(query: string, max = 10, signal?: AbortSignal): Promise<MailSummary[]> {
	const q = new URLSearchParams({ maxResults: String(Math.max(1, Math.min(25, max))), q: query.trim() || "in:inbox" });
	const list = await googleApi<{ messages?: { id: string }[] }>(`${API}/messages?${q}`, { signal });
	const ids = (list.messages ?? []).map((m) => m.id);
	const meta = new URLSearchParams({ format: "metadata" });
	for (const h of ["From", "To", "Subject", "Date"]) meta.append("metadataHeaders", h);
	return Promise.all(ids.map(async (id) => summary(await googleApi<Message>(`${API}/messages/${encodeURIComponent(id)}?${meta}`, { signal }))));
}

/** El texto de un correo: la parte text/plain, o la HTML pasada a texto. */
export function extractBody(p: Part | undefined): { text: string; attachments: string[] } {
	let plain = "";
	let html = "";
	const attachments: string[] = [];
	const walk = (part: Part | undefined) => {
		if (!part) return;
		if (part.filename) attachments.push(part.filename);
		else if (part.mimeType === "text/plain" && !plain) plain = decode(part.body?.data);
		else if (part.mimeType === "text/html" && !html) html = decode(part.body?.data);
		part.parts?.forEach(walk);
	};
	walk(p);
	return { text: (plain || (html ? htmlToText(html) : "")).replace(/\r\n/g, "\n").trim(), attachments };
}

export async function readMail(id: string, signal?: AbortSignal): Promise<MailFull> {
	const m = await googleApi<Message>(`${API}/messages/${encodeURIComponent(id)}?format=full`, { signal });
	const { text, attachments } = extractBody(m.payload);
	return {
		...summary(m),
		cc: header(m.payload, "Cc"),
		messageId: header(m.payload, "Message-ID"),
		references: header(m.payload, "References"),
		body: text,
		attachments,
	};
}

/** Un encabezado con tildes o eñes, codificado como pide el estándar del correo. */
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`);
/** Sin saltos de línea en los encabezados (evita que alguien cuele otro encabezado). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export type Outgoing = { to: string; cc?: string; subject: string; body: string; replyTo?: MailFull };

/** El correo en formato RFC 2822, en base64url como lo pide la API. */
export function buildRaw(o: Outgoing): string {
	const subject = o.replyTo && !/^re:/i.test(o.subject) ? `Re: ${o.subject}` : o.subject;
	const lines = [`To: ${oneLine(o.to)}`];
	if (o.cc?.trim()) lines.push(`Cc: ${oneLine(o.cc)}`);
	lines.push(`Subject: ${encodeHeader(oneLine(subject))}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
	if (o.replyTo?.messageId) {
		lines.push(`In-Reply-To: ${oneLine(o.replyTo.messageId)}`, `References: ${oneLine(`${o.replyTo.references} ${o.replyTo.messageId}`)}`);
	}
	const body = Buffer.from(o.body.replace(/\r?\n/g, "\r\n"), "utf-8").toString("base64").replace(/.{76}/g, "$&\r\n");
	return Buffer.from(`${lines.join("\r\n")}\r\n\r\n${body}`, "utf-8").toString("base64url");
}

export async function sendMail(o: Outgoing, signal?: AbortSignal): Promise<{ id: string }> {
	return googleApi<{ id: string }>(`${API}/messages/send`, { method: "POST", body: { raw: buildRaw(o), ...(o.replyTo ? { threadId: o.replyTo.threadId } : {}) }, signal });
}

export async function draftMail(o: Outgoing, signal?: AbortSignal): Promise<{ id: string }> {
	return googleApi<{ id: string }>(`${API}/drafts`, { method: "POST", body: { message: { raw: buildRaw(o), ...(o.replyTo ? { threadId: o.replyTo.threadId } : {}) } }, signal });
}
