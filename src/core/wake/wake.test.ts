import { test } from "node:test";
import assert from "node:assert/strict";
import { callsWake, wakeVariants } from "./wakeWord.js";
import { autostartCommand } from "./autostart.js";
import { explainWakeError } from "./wakeListener.js";
import { detectRoomIntent } from "../rooms/roomIntent.js";

test("Palabra de activación: «Aku» acepta cómo lo transcribe mal el dictado", () => {
	const v = wakeVariants("Aku").map((x) => x.toLowerCase());
	for (const w of ["aku", "haiku", "acu", "jaiku"]) assert.ok(v.includes(w), w);
	assert.equal(new Set(v).size, v.length, "sin repetidos");
	// Los más parecidos no traen «Haiku».
	assert.ok(!wakeVariants("Aku", true).map((x) => x.toLowerCase()).includes("haiku"));
	// Otra palabra no trae los parecidos de Aku.
	assert.deepEqual(wakeVariants("Jarvis"), ["Jarvis"]);
	assert.deepEqual(wakeVariants("  "), []);
});

test("Palabra de activación: la frase tiene que empezar llamando a Aku", () => {
	for (const f of ["Aku.", "Aku, me escuchas.", "Oye Aku, qué hora es", "Oyeaku, qué hora es.", "Haiku, actívate.", "Jaiku."]) {
		assert.ok(callsWake(f, "Aku"), f);
	}
	for (const f of ["escribe un haiku", "la cuca corrió", "Ayer fui a Cuba", "", "hola"]) assert.ok(!callsWake(f, "Aku"), f);
});

test("Palabra de activación: la sensibilidad cambia cuánto acepta", () => {
	assert.ok(callsWake("Aku", "Aku", "low"));
	assert.ok(!callsWake("Haiku, actívate", "Aku", "low"));
	assert.ok(callsWake("Haiku, actívate", "Aku", "medium"));
	assert.ok(!callsWake("bueno, Aku, ayúdame", "Aku", "medium"));
	assert.ok(callsWake("bueno, Aku, ayúdame", "Aku", "high"));
	assert.ok(callsWake("Jarvis, enciende", "Jarvis"));
});

test("Palabra de activación: «Haiku, actívate» en el chat vale como «Aku, actívate»", () => {
	const agents = [{ id: "viernes", name: "Viernes", aliases: [] }] as never;
	const wakeWords = [...wakeVariants("Aku"), "Shiro"];
	assert.deepEqual(detectRoomIntent("Haiku, actívate", { agents, room: null, wakeWords }), { kind: "wakeOnly" });
	assert.deepEqual(detectRoomIntent("Acu", { agents, room: null, wakeWords }), { kind: "wakeOnly" });
	// Hablar de un haiku no es llamarlo.
	assert.equal(detectRoomIntent("escribe un haiku", { agents, room: null, wakeWords }), null);
});

test("Arrancar con Windows: la orden con el .exe y desde el código", () => {
	assert.equal(autostartCommand(true, "C:\\Programas\\Aku\\Aku.exe"), '"C:\\Programas\\Aku\\Aku.exe" --bandeja');
	const src = autostartCommand(false, "node.exe", "C:\\Users\\a\\Mis cosas'\\Shiro");
	assert.match(src, /-WindowStyle Hidden/);
	assert.match(src, /Set-Location -LiteralPath 'C:\\Users\\a\\Mis cosas''\\Shiro'/);
	assert.match(src, /npm run app -- --bandeja/);
});

test("Palabra de activación: los errores del micrófono se explican", () => {
	assert.match(explainWakeError("mic 2"), /No encuentro un micrófono/);
	assert.match(explainWakeError("mic 4"), /Otro programa/);
	assert.match(explainWakeError("silencio"), /Privacidad/);
	assert.match(explainWakeError(""), /sin decir por qué/);
});
