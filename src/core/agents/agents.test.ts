import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

test("cada agente es una nota en Agentes/; renombrar cambia el archivo", () => {
	const files = () => readdirSync(reg.agentsDir()).sort();
	assert.deepEqual(files(), ["Viernes.md"]);
	const note = readFileSync(join(reg.agentsDir(), "Viernes.md"), "utf-8");
	assert.match(note, /^---\nid: viernes\nnombre: "Viernes"\nalias: \["Vie"\]/);
	assert.match(note, /herramientas: "todas"/);
	assert.match(note, /---\nAyudas con las tareas del día\.\n$/);
	const { agent } = reg.createAgent({ name: "Domingo" }, ctx);
	reg.updateAgent(agent.id, { name: "Domingo Feliz" }, ctx);
	assert.deepEqual(files(), ["Domingo Feliz.md", "Viernes.md"]);
	reg.deleteAgent(agent.id);
	assert.deepEqual(files(), ["Viernes.md"]);
});

test("la nota de un agente se lee igual que se escribe, y también escrita a mano", () => {
	const full = {
		id: "sabado",
		name: "Sábado",
		aliases: ["Sab", "Sabi"],
		description: "Revisa código",
		provider: "lmstudio" as const,
		model: "qwen/qwen3.5-9b",
		baseUrl: "http://localhost:1234/v1",
		persona: "Eres serio.\n\nSiempre das ejemplos: {{nombre}}.",
		personaMode: "replace" as const,
		tools: ["search_web", "get_time"],
		mcp: false,
		mode: "voice" as const,
		voice: { browserVoiceURI: "Microsoft Pablo - Spanish", serverVoice: "nova", rate: 1.2 },
		greeting: "Hola: soy {{nombre}}",
		color: "#ff8800",
	};
	assert.deepEqual(reg.parseAgentNote(reg.agentToMarkdown(full), "Sábado.md"), full);

	const hand = reg.parseAgentNote(
		"---\nnombre: Martes\nalias: Mar, Marti\nherramientas: ninguna\nmodo: voz\nmcp: no\ncolor: '#00aa00'\n---\nHablas como pirata.\n",
		"Martes.md",
	);
	assert.equal(hand.id, "martes");
	assert.deepEqual(hand.aliases, ["Mar", "Marti"]);
	assert.equal(hand.tools, "none");
	assert.equal(hand.mode, "voice");
	assert.equal(hand.mcp, false);
	assert.equal(hand.color, "#00aa00");
	assert.equal(hand.persona, "Hablas como pirata.");
	// Sin nombre: el del archivo.
	assert.equal(reg.parseAgentNote("Solo texto", "Jueves.md").name, "Jueves");
});

test("ids únicos, notas rotas y el viejo agents.json", () => {
	const { agent } = reg.createAgent({ name: "Viernes 2" }, ctx);
	assert.equal(agent.id, "viernes-2");

	writeFileSync(join(reg.agentsDir(), "Roto.md"), '---\nid: "MAL ID"\n---\n', "utf-8");
	const { agents, error } = reg.loadAgents();
	assert.deepEqual(agents.map((a) => a.id).sort(), ["viernes", "viernes-2"], "las demás notas siguen valiendo");
	assert.match(error!, /Agentes\/Roto\.md: id/);
	assert.throws(() => reg.createAgent({ name: "Nuevo" }, ctx), /Arréglalo/);
	rmSync(join(reg.agentsDir(), "Roto.md"));

	// Los de data/agents.json pasan a notas y el archivo se borra.
	mkdirSync(join(TMP, "data"), { recursive: true });
	writeFileSync(reg.AGENTS_FILE, JSON.stringify({ agents: [{ id: "martes", name: "Martes" }, { id: "viernes", name: "Otro" }] }), "utf-8");
	const adopted = reg.loadAgents().agents;
	assert.ok(adopted.some((a) => a.id === "martes"));
	assert.equal(adopted.find((a) => a.id === "viernes")?.name, "Viernes", "no pisa la nota que ya había");
	assert.ok(!existsSync(reg.AGENTS_FILE));

	writeFileSync(reg.AGENTS_FILE, "{ roto", "utf-8");
	assert.match(reg.loadAgents().error!, /data\/agents.json tiene un error/);
	rmSync(reg.AGENTS_FILE);
});
