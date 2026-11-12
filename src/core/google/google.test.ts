import { test } from "node:test";
import assert from "node:assert/strict";
import { setConfig } from "../../config/config.js";
import { buildRaw, extractBody } from "./gmail.js";
import { buildEvent, parseWhen } from "./calendar.js";
import { finishGoogleAuth, getGoogleStatus, googleConnected, startGoogleAuth } from "./googleAuth.js";
import { alwaysAsksUser, describeRiskyAction } from "../tools/approval.js";
import { isExternalTool } from "../tools/untrusted.js";

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf-8");

test("correo: arma el mensaje con tildes y sin colar encabezados", () => {
	const raw = decodeRaw(buildRaw({ to: "ana@example.com\nBcc: espia@example.com", subject: "Reunión mañana", body: "Hola Ana,\nnos vemos." }));
	const [head, body] = raw.split("\r\n\r\n");
	assert.match(head, /^To: ana@example.com Bcc: espia@example.com$/m, "el salto de línea no crea otro encabezado");
	assert.doesNotMatch(head, /^Bcc:/m);
	assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
	assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf-8"), "Hola Ana,\r\nnos vemos.");
});

test("correo: una respuesta lleva Re: y los datos de la conversación", () => {
	const replyTo = { id: "1", threadId: "t1", from: "a@x.com", to: "", subject: "Factura", date: "", snippet: "", unread: false, cc: "", messageId: "<m1@x>", references: "<m0@x>", body: "", attachments: [] };
	const head = decodeRaw(buildRaw({ to: "a@x.com", subject: "Factura", body: "ok", replyTo })).split("\r\n\r\n")[0];
	assert.match(head, /^Subject: Re: Factura$/m);
	assert.match(head, /^In-Reply-To: <m1@x>$/m);
	assert.match(head, /^References: <m0@x> <m1@x>$/m);
});

test("correo: saca el texto (o el HTML pasado a texto) y los adjuntos", () => {
	const b64 = (s: string) => Buffer.from(s).toString("base64url");
	const r = extractBody({
		mimeType: "multipart/mixed",
		parts: [
			{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64("<p>Hola <b>mundo</b></p>") } }] },
			{ mimeType: "application/pdf", filename: "factura.pdf", body: {} },
		],
	});
	assert.match(r.text, /Hola\s+mundo/);
	assert.deepEqual(r.attachments, ["factura.pdf"]);
});

test("calendario: fechas y fin por defecto", () => {
	assert.deepEqual(parseWhen("2026-11-20"), { date: "2026-11-20" });
	assert.equal(parseWhen("2026-11-20 15:00").dateTime, "2026-11-20T15:00:00");
	assert.ok(parseWhen("2026-11-20T15:00").timeZone, "sin zona usa la del equipo");
	assert.deepEqual(parseWhen("2026-11-20T15:00:00-03:00"), { dateTime: "2026-11-20T15:00:00-03:00" });
	assert.throws(() => parseWhen("el viernes"), /No entiendo la fecha/);

	const e = buildEvent({ title: "Dentista", start: "2026-11-20T23:30" }) as { start: { dateTime: string }; end: { dateTime: string } };
	assert.equal(e.end.dateTime, "2026-11-21T00:30:00", "una hora después, aunque cambie de día");
	const allDay = buildEvent({ title: "Viaje", start: "2026-11-30" }) as { end: { date: string } };
	assert.equal(allDay.end.date, "2026-12-01");
	assert.throws(() => buildEvent({ title: "x", start: "2026-11-20", end: "2026-11-20T10:00" }), /los dos/);
});

test("enviar y crear eventos preguntan siempre; leer no", () => {
	assert.equal(describeRiskyAction("email", { action: "search", query: "is:unread" }), null);
	assert.equal(describeRiskyAction("email", { action: "draft", to: "a@x.com", body: "hola" }), null);
	assert.match(describeRiskyAction("email", { action: "send", to: "a@x.com", subject: "Hola", body: "Texto" }) ?? "", /Enviar un correo a a@x.com[\s\S]*Texto/);
	assert.match(describeRiskyAction("calendar", { action: "create", title: "Cena", start: "2026-11-20T20:00", attendees: ["b@x.com"] }) ?? "", /invitación a: b@x.com/);
	assert.equal(describeRiskyAction("calendar", { action: "list" }), null);
	assert.equal(alwaysAsksUser("email", { action: "send" }), true);
	assert.equal(alwaysAsksUser("calendar", { action: "create" }), true);
	assert.equal(alwaysAsksUser("email", { action: "draft" }), false);
	assert.ok(isExternalTool("email") && isExternalTool("calendar"), "lo que traen es contenido externo");
});

test("conectar: dirección de Google con state y PKCE, y vuelta que no se puede falsificar", async () => {
	assert.equal(googleConnected(), false);
	assert.throws(() => startGoogleAuth(1417), /id y el secreto/);
	setConfig({ googleClientId: "123-abc.apps.googleusercontent.com", googleClientSecret: "GOCSPX-prueba" });
	const url = new URL(startGoogleAuth(1417));
	assert.equal(url.origin, "https://accounts.google.com");
	assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:1417/api/google/callback");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.match(url.searchParams.get("scope") ?? "", /gmail\.readonly.*calendar\.events/);
	assert.ok((url.searchParams.get("state") ?? "").length >= 30);
	await assert.rejects(finishGoogleAuth(new URLSearchParams({ state: "inventado", code: "x" })), /ya no vale/);
	// El state es de un solo uso: si Google responde con un error, ese state queda gastado.
	const state = url.searchParams.get("state")!;
	await assert.rejects(finishGoogleAuth(new URLSearchParams({ state, error: "access_denied" })), /No diste permiso/);
	await assert.rejects(finishGoogleAuth(new URLSearchParams({ state, code: "x" })), /ya no vale/);
	assert.deepEqual([getGoogleStatus().configured, getGoogleStatus().connected], [true, false]);
	setConfig({ googleClientId: undefined, googleClientSecret: undefined });
});
