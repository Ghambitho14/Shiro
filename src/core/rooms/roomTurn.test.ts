import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-roomturn-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
for (const k of ["SHIRO_LLM_PROVIDER", "SHIRO_LLM_MODEL", "SHIRO_LLM_BASE_URL"]) delete process.env[k];
after(() => rmSync(TMP, { recursive: true, force: true }));

const { setConfig } = await import("../../config/config.js");
const { agentProfileSchema } = await import("../agents/registry.js");
const { newRoom } = await import("./roomStore.js");
const { planRoomTurn, prepareAgentTurn } = await import("./roomTurn.js");

setConfig({ llmProvider: "ollama", llmModel: "qwen3:8b", wakeWord: "Aku" });

const viernes = agentProfileSchema.parse({ id: "viernes", name: "Viernes", description: "tareas del día", persona: "Eres {{nombre}}, seria." });
const lunes = agentProfileSchema.parse({ id: "lunes", name: "Lunes", tools: "none", model: "llama3.2:3b", personaMode: "replace", persona: "Solo rimas." });
const agents = [viernes, lunes];
const both = { ...newRoom("s1", "viernes", 1), participants: [{ agentId: "viernes", joinedAt: 1 }, { agentId: "lunes", joinedAt: 2 }] };

const plan = (goal: string, room: typeof both | null = null, list = agents) =>
	planRoomTurn(goal, { sessionId: "s1", room, agents: list, assistantName: "Shiro" });

const turn = (profile = viernes, opts: { baseTools?: string[]; autonomous?: boolean } = {}) =>
	prepareAgentTurn(profile, {
		room: both,
		agents,
		messages: [{ role: "user", content: "hola" }],
		assistantName: "Shiro",
		baseTools: opts.baseTools,
		autonomous: opts.autonomous ?? true,
	});

test("planRoomTurn: una orden se contesta con texto fijo, sin modelo", () => {
	const p = plan("Aku, activa Viernes");
	assert.ok(p);
	assert.equal(p.responder, undefined);
	assert.equal(p.reply?.agent?.id, "viernes");
	assert.equal(p.reply?.text, "Hola, soy Viernes. ¿En qué te ayudo?");
	assert.equal(p.changed, true);
	assert.equal(p.room?.principal, "viernes");

	const close = plan("cierra la sala", both);
	assert.equal(close?.room, null);
	assert.equal(close?.reply?.agent, null, "lo dice el asistente de siempre");
});

test("planRoomTurn: un mensaje dentro de la sala lo responde un agente con su modelo", () => {
	const p = plan("¿Qué opinas, Lunes?", both);
	assert.equal(p?.responder?.id, "lunes");
	assert.equal(p?.reply, undefined);
	assert.equal(p?.changed, false);
	// Sin nombrar a nadie, responde el principal.
	assert.equal(plan("recuérdame el lunes comprar pan", both)?.responder?.id, "viernes");
	// Activar y pedir algo a la vez: responde el agente, sin el saludo.
	const withAsk = plan("Aku, activa Viernes y dime la hora");
	assert.equal(withAsk?.responder?.id, "viernes");
	assert.equal(withAsk?.reply, undefined);
	assert.equal(withAsk?.room?.principal, "viernes");
});

test("planRoomTurn: sin sala ni orden (o sin agentes) sigue el asistente de siempre", () => {
	assert.equal(plan("¿qué hora es?"), null);
	assert.equal(plan("Aku, activa Viernes", null, []), null);
});

test("prepareAgentTurn: herramientas del agente", () => {
	const base = ["search_web", "fetch_url", "get_weather"];
	// none = solo texto.
	assert.deepEqual(turn(lunes, { baseTools: base }).allowedTools, []);
	// inherit = las mismas que el asistente.
	assert.deepEqual(turn(viernes, { baseTools: base }).allowedTools, base);
	assert.equal(turn(viernes, { baseTools: undefined }).allowedTools, undefined);
	// Una lista: sin modo autónomo, solo las que permite Ajustes.
	const listed = agentProfileSchema.parse({ id: "marte", name: "Marte", tools: ["search_web", "exec"] });
	assert.deepEqual(turn(listed, { baseTools: base, autonomous: false }).allowedTools, ["search_web"]);
	assert.deepEqual(turn(listed, { baseTools: base, autonomous: true }).allowedTools, ["search_web", "exec"]);
	assert.deepEqual(turn(listed, { baseTools: undefined, autonomous: false }).allowedTools, ["search_web", "exec"]);
	// MCP: solo en modo autónomo y si el agente lo tiene.
	assert.equal(turn(viernes, { autonomous: true }).mcp, true);
	assert.equal(turn(viernes, { autonomous: false }).mcp, false);
	const noMcp = agentProfileSchema.parse({ id: "marte", name: "Marte", mcp: false });
	assert.equal(turn(noMcp, { autonomous: true }).mcp, false);
});

test("prepareAgentTurn: modelo, forma de ser y sala del agente", () => {
	const v = turn(viernes);
	assert.equal(v.agentName, "Viernes");
	assert.equal(v.llm.getConfig().model, "qwen3:8b", "sin modelo propio usa el de Ajustes");
	assert.deepEqual(v.persona, { prompt: "Eres {{nombre}}, seria.", replace: false });
	assert.deepEqual(v.room, {
		self: "Viernes",
		participants: [
			{ name: "Viernes", description: "tareas del día", principal: true },
			{ name: "Lunes", description: undefined, principal: false },
		],
		omitted: 0,
	});
	assert.deepEqual(v.conversation, [{ role: "user", content: "hola" }]);

	const l = turn(lunes);
	assert.equal(l.llm.getConfig().model, "llama3.2:3b");
	assert.deepEqual(l.persona, { prompt: "Solo rimas.", replace: true });
	// Sin forma de ser escrita no se manda nada.
	assert.equal(turn(agentProfileSchema.parse({ id: "marte", name: "Marte" })).persona, undefined);
});
