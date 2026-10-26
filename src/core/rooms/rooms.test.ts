import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-rooms-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { agentProfileSchema } = await import("../agents/registry.js");
const { detectRoomIntent } = await import("./roomIntent.js");
const { applyRoomIntent } = await import("./roomLogic.js");
const { buildRoomHistory } = await import("./roomHistory.js");
const store = await import("./roomStore.js");

const viernes = agentProfileSchema.parse({ id: "viernes", name: "Viernes", description: "tareas del día" });
const lunes = agentProfileSchema.parse({ id: "lunes", name: "Lunes", aliases: ["Señor Lunes"], mode: "voice" });
const agents = [viernes, lunes];
const wakeWords = ["Aku", "Shiro"];
const roomWithBoth = { ...store.newRoom("s1", "viernes", 1), participants: [{ agentId: "viernes", joinedAt: 1 }, { agentId: "lunes", joinedAt: 2 }] };
const roomViernes = store.newRoom("s1", "viernes", 1);

const detect = (text: string, room: typeof roomWithBoth | null = null) => detectRoomIntent(text, { agents, room, wakeWords });

test("órdenes de sala con palabras, sin tildes ni mayúsculas", () => {
	assert.deepEqual(detect("Aku, activa Viernes"), { kind: "activate", agentId: "viernes", rest: undefined });
	assert.deepEqual(detect("Oye Shiro, quiero hablar con Lunes por favor"), { kind: "activate", agentId: "lunes", rest: undefined });
	assert.deepEqual(detect("Viernes, agrega a Lunes", roomViernes), { kind: "add", agentId: "lunes", rest: undefined });
	assert.deepEqual(detect("Añade a LUNES", roomViernes), { kind: "add", agentId: "lunes", rest: undefined });
	assert.deepEqual(detect("trae a Señor Lunes", roomViernes), { kind: "add", agentId: "lunes", rest: undefined }, "alias de dos palabras");
	assert.deepEqual(detect("agrega a Lunes"), { kind: "activate", agentId: "lunes", rest: undefined }, "sin sala, sumar es activar");
	assert.deepEqual(detect("gracias Lunes, puedes irte", roomWithBoth), { kind: "dismiss", agentId: "lunes" });
	assert.deepEqual(detect("saca a Lunes de la sala", roomWithBoth), { kind: "dismiss", agentId: "lunes" });
	assert.deepEqual(detect("Lunes, ahora te encargas tú", roomWithBoth), { kind: "promote", agentId: "lunes" });
	assert.deepEqual(detect("pásale el mando a Lunes", roomWithBoth), { kind: "promote", agentId: "lunes" });
	assert.deepEqual(detect("cierra la sala", roomWithBoth), { kind: "close" });
	assert.deepEqual(detect("Aku"), { kind: "wakeOnly" });
	assert.deepEqual(detect("Aku, activa"), { kind: "wakeOnly" });
});

test("activar con una petición: el agente también la responde", () => {
	assert.deepEqual(detect("Aku, activa Viernes y dime el clima"), { kind: "activate", agentId: "viernes", rest: "dime el clima" });
});

test("lo que no es de salas sigue al asistente de siempre", () => {
	assert.equal(detect("activa el wifi"), null);
	assert.equal(detect("¿qué tiempo hace el viernes?"), null);
	// Despedir a alguien que no está en la sala no es una orden.
	assert.deepEqual(detect("gracias Lunes, puedes irte", roomViernes), { kind: "route", agentId: "viernes", mentioned: false });
});

test("quién responde en una sala: el nombrado o el principal", () => {
	assert.deepEqual(detect("¿qué opinas, Lunes?", roomWithBoth), { kind: "route", agentId: "lunes", mentioned: true });
	assert.deepEqual(detect("recuérdame el lunes comprar pan", roomWithBoth), { kind: "route", agentId: "viernes", mentioned: false });
	assert.deepEqual(detect("hasta el próximo viernes, lunes", roomWithBoth), { kind: "route", agentId: "lunes", mentioned: true });
	assert.deepEqual(detect("Viernes, pregúntale a Lunes", roomWithBoth), { kind: "route", agentId: "viernes", mentioned: true });
	assert.deepEqual(detect("@lunes hola", roomWithBoth), { kind: "route", agentId: "lunes", mentioned: true });
	assert.deepEqual(detect("para el @lunes", roomWithBoth), { kind: "route", agentId: "lunes", mentioned: true });
	assert.deepEqual(detect("hola señor lunes", roomWithBoth), { kind: "route", agentId: "lunes", mentioned: true });
	assert.deepEqual(detect("¿cómo va todo?", roomWithBoth), { kind: "route", agentId: "viernes", mentioned: false });
});

const ctx = { agents, sessionId: "s1", defaultName: "Shiro", now: 5 };

test("activar crea la sala con el saludo del agente", () => {
	const r = applyRoomIntent(null, { kind: "activate", agentId: "lunes" }, ctx);
	assert.equal(r.changed, true);
	assert.equal(r.room?.principal, "lunes");
	assert.deepEqual(r.reply, { agentId: "lunes", text: "Hola, soy Lunes. ¿En qué te ayudo?" });
	assert.equal(r.openVoice, true, "Lunes prefiere la voz");
	assert.equal(r.runTurn, undefined);
	const withRest = applyRoomIntent(null, { kind: "activate", agentId: "viernes", rest: "dime el clima" }, ctx);
	assert.deepEqual(withRest.runTurn, { agentId: "viernes" });
});

test("sumar, despedir, cambiar de principal y cerrar", () => {
	const add = applyRoomIntent(roomViernes, { kind: "add", agentId: "lunes" }, ctx);
	assert.deepEqual(add.room?.participants.map((p) => p.agentId), ["viernes", "lunes"]);
	assert.equal(add.reply?.agentId, "lunes");
	assert.equal(applyRoomIntent(add.room, { kind: "add", agentId: "lunes" }, ctx).reply?.text, "Ya estoy en la sala.");

	const bye = applyRoomIntent(roomWithBoth, { kind: "dismiss", agentId: "lunes" }, ctx);
	assert.deepEqual(bye.room?.participants.map((p) => p.agentId), ["viernes"]);
	assert.deepEqual(bye.reply, { agentId: "lunes", text: "¡Hasta luego!" });

	const principalLeaves = applyRoomIntent(roomWithBoth, { kind: "dismiss", agentId: "viernes" }, ctx);
	assert.equal(principalLeaves.room?.principal, "lunes");
	assert.equal(principalLeaves.reply?.text, "Me retiro. Ahora te atiende Lunes.");

	const last = applyRoomIntent(roomViernes, { kind: "dismiss", agentId: "viernes" }, ctx);
	assert.equal(last.room, null);
	assert.deepEqual(last.reply, { agentId: null, text: "Viernes se fue. Sigo yo, Shiro." });

	const promote = applyRoomIntent(roomViernes, { kind: "promote", agentId: "lunes" }, ctx);
	assert.equal(promote.room?.principal, "lunes");
	assert.equal(promote.room?.participants.length, 2, "si no estaba, entra");

	const close = applyRoomIntent(roomWithBoth, { kind: "close" }, ctx);
	assert.equal(close.room, null);
	assert.equal(close.changed, true);

	assert.match(applyRoomIntent(null, { kind: "wakeOnly" }, ctx).reply!.text, /Viernes y Lunes/);
	assert.deepEqual(applyRoomIntent(roomWithBoth, { kind: "route", agentId: "lunes", mentioned: true }, ctx).runTurn, { agentId: "lunes" });
});

const nameOf = (id: string | undefined) => (id === "lunes" ? "Lunes" : id === "viernes" ? "Viernes" : "Shiro");

test("historial de sala: lo de los demás va con su nombre", () => {
	const msgs = [
		{ role: "user" as const, content: "hola" },
		{ role: "assistant" as const, content: "¡Hola! Soy Shiro." },
		{ role: "user" as const, content: "activa Viernes" },
		{ role: "assistant" as const, content: "Hola, soy Viernes.", agent: "viernes" },
		{ role: "user" as const, content: "¿qué opinas, Lunes?" },
	];
	const { conversation, omitted } = buildRoomHistory(msgs, "viernes", nameOf);
	assert.equal(omitted, 0);
	assert.deepEqual(conversation, [
		{ role: "user", content: "[Usuario]: hola\n\n[Shiro]: ¡Hola! Soy Shiro.\n\n[Usuario]: activa Viernes" },
		{ role: "assistant", content: "Hola, soy Viernes." },
		{ role: "user", content: "¿qué opinas, Lunes?" },
	]);
	const forLunes = buildRoomHistory(msgs, "lunes", nameOf).conversation;
	assert.equal(forLunes.length, 1, "para Lunes todo es de otros: un solo mensaje");
	assert.match(forLunes[0].content as string, /\[Viernes\]: Hola, soy Viernes\.\n\n\[Usuario\]: ¿qué opinas, Lunes\?$/);
});

test("historial de sala: imágenes y recorte sin perder el último mensaje", () => {
	const img = [{ type: "text" as const, text: "mira" }, { type: "image_url" as const, image_url: { url: "data:x" } }];
	const msgs = [
		{ role: "assistant" as const, content: "algo", agent: "lunes" },
		{ role: "user" as const, content: img },
	];
	const conv = buildRoomHistory(msgs, "viernes", nameOf).conversation;
	assert.deepEqual(conv[0].content, [{ type: "text", text: "[Lunes]: algo" }, { type: "text", text: "[Usuario]: mira" }, img[1]]);

	const long = Array.from({ length: 40 }, (_, i) =>
		i % 2 ? { role: "assistant" as const, content: "r".repeat(100), agent: "viernes" } : { role: "user" as const, content: `p${i}` },
	);
	const capped = buildRoomHistory(long, "viernes", nameOf, { maxMessages: 10 });
	assert.equal(capped.omitted, 30);
	assert.equal(capped.conversation[0].role, "user", "empieza por el usuario");
	const tiny = buildRoomHistory([...long, { role: "user" as const, content: "x".repeat(500) }], "viernes", nameOf, { maxChars: 50 });
	assert.equal(tiny.conversation.length, 1);
	assert.equal(tiny.conversation[0].content, "x".repeat(500), "el último mensaje nunca se quita");
});

test("salas guardadas: crear, quitar agentes borrados y borrar", () => {
	assert.throws(() => store.saveRoom({ ...roomViernes, sessionId: "../fuera" }), /no válido/);
	assert.equal(store.getRoom("../fuera", agents), null);
	store.saveRoom(roomWithBoth);
	assert.deepEqual(store.getRoom("s1", agents)?.participants.map((p) => p.agentId), ["viernes", "lunes"]);
	// Si se borra Viernes (el principal), queda Lunes al mando.
	const pruned = store.getRoom("s1", [lunes]);
	assert.equal(pruned?.principal, "lunes");
	assert.equal(store.getRoom("s1", []), null, "sin agentes no hay sala");
	store.deleteRoom("s1");
	assert.equal(existsSync(join(store.ROOMS_DIR, "s1.json")), false);
});
