import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-agents-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const text = await import("./text.js");
const reg = await import("./registry.js");

const ctx = { assistantName: "Shiro", wakeWord: "Aku", knownTools: ["search_web", "get_time"] };

test("nombres sin tildes, mayúsculas ni puntuación", () => {
	assert.equal(text.normalizeText("¿Qué opinas, LÚNES?"), "que opinas lunes");
	assert.equal(text.normalizeText("Añade a @Lunes", true), "anade a @lunes");
	assert.equal(text.slugify("Señor Lunes"), "senor-lunes");
});

test("crear, editar y borrar agentes", () => {
	const { agent } = reg.createAgent({ name: "Viernes", aliases: ["Vie"], persona: "Ayudas con las tareas del día." }, ctx);
	assert.equal(agent.id, "viernes");
	assert.equal(agent.tools, "inherit");
	assert.equal(agent.personaMode, "add");
	const second = reg.createAgent({ name: "Lunes", tools: ["search_web", "no_existe"] }, ctx);
	assert.deepEqual(second.agent.tools, ["search_web"]);
	assert.match(second.warnings.join(" "), /no_existe/);

	const renamed = reg.updateAgent("lunes", { name: "Lunes Pro", color: "#ff8800" }, ctx);
	assert.equal(renamed.agent.id, "lunes", "el id no cambia al renombrar");
	assert.equal(reg.getAgent("lunes")?.name, "Lunes Pro");
	assert.equal(reg.renderGreeting(renamed.agent), "Hola, soy Lunes Pro. ¿En qué te ayudo?");

	assert.equal(reg.deleteAgent("lunes"), true);
	assert.equal(reg.deleteAgent("lunes"), false);
	assert.deepEqual(reg.loadAgents().agents.map((a) => a.id), ["viernes"]);
});

test("los nombres no se pueden confundir", () => {
	assert.throws(() => reg.createAgent({ name: "viérnes" }, ctx), /ya lo usa Viernes/);
	assert.throws(() => reg.createAgent({ name: "Otro", aliases: ["vie"] }, ctx), /ya lo usa Viernes/);
	assert.throws(() => reg.createAgent({ name: "Shiro" }, ctx), /igual que el asistente/);
	assert.throws(() => reg.createAgent({ name: "AKU" }, ctx), /palabra de activación/);
	assert.throws(() => reg.createAgent({ name: "Sala" }, ctx), /órdenes de sala/);
	assert.throws(() => reg.createAgent({ name: "Al" }, ctx), /al menos 3 letras/);
	assert.throws(() => reg.createAgent({ name: "" }, ctx), /nombre/);
});

test("ids únicos y archivo roto con error en español", () => {
	const { agent } = reg.createAgent({ name: "Viernes 2" }, ctx);
	assert.equal(agent.id, "viernes-2");
	mkdirSync(join(TMP, "data"), { recursive: true });
	writeFileSync(reg.AGENTS_FILE, "{ roto", "utf-8");
	const { agents, error } = reg.loadAgents();
	assert.deepEqual(agents, []);
	assert.match(error!, /data\/agents.json tiene un error: El JSON no es válido/);
	assert.throws(() => reg.createAgent({ name: "Nuevo" }, ctx), /Arréglalo o bórralo/);
});
