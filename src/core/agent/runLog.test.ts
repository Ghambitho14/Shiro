import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const { appendRunLog, readRunLog, summarizeRuns, clearRunLog } = await import("./runLog.js");
const { DATA_DIR } = await import("../../config/config.js");
type Entry = import("./runLog.js").RunLogEntry;

const entry = (over: Partial<Entry> = {}): Entry => ({
	at: new Date().toISOString(),
	durationMs: 1200,
	sessionId: "chat-1",
	agent: "Aku",
	mode: "chat",
	permissions: "ask",
	provider: "lmstudio",
	model: "qwen",
	goal: "hola",
	recalled: 0,
	tools: [],
	usage: { input: 10, output: 5, turns: 1 },
	outcome: "ok",
	...over,
});

test("registro: guarda cada respuesta, la más nueva primero, sin el mensaje entero", () => {
	clearRunLog();
	appendRunLog(entry({ goal: "primera" }));
	appendRunLog(entry({ goal: "x".repeat(500), sessionId: "chat-2", tools: [{ name: "project", ms: 30, ok: false, error: "no existe" }], outcome: "error", error: "falló" }));
	const all = readRunLog();
	assert.equal(all.length, 2);
	assert.equal(all[1].goal, "primera");
	assert.ok(all[0].goal.length <= 121, "del mensaje solo queda el comienzo");
	assert.deepEqual(
		readRunLog({ sessionId: "chat-1" }).map((e) => e.goal),
		["primera"],
	);
	const s = summarizeRuns(all);
	assert.equal(s.runs, 2);
	assert.equal(s.failed, 1);
	assert.deepEqual(s.failingTools, [{ name: "project", failed: 1, total: 1 }]);
	clearRunLog();
	assert.deepEqual(readRunLog(), []);
});

test("registro: una línea cortada (Aku se cerró al escribir) no rompe la lectura", () => {
	clearRunLog();
	appendRunLog(entry({ goal: "buena" }));
	appendFileSync(join(DATA_DIR, "logs", "runs.jsonl"), '{"at":"2026-');
	assert.deepEqual(
		readRunLog().map((e) => e.goal),
		["buena"],
	);
});

test("registro: resumen por modelo y por herramienta (medias por respuesta; las detenidas no cuentan para tiempo ni tokens)", () => {
	const s = summarizeRuns([
		entry({ model: "qwen", durationMs: 1000, usage: { input: 100, output: 20, reasoning: 10, turns: 1 }, tools: [{ name: "project", ms: 40, ok: true }] }),
		entry({ model: "qwen", durationMs: 3000, usage: { input: 300, output: 40, turns: 2 }, outcome: "error", tools: [{ name: "project", ms: 60, ok: false, error: "x" }, { name: "fetch_url", ms: 500, ok: true }] }),
		entry({ model: "qwen", durationMs: 99_000, usage: { input: 9999, output: 9999, turns: 9 }, outcome: "cancelled" }),
		entry({ provider: "opencode", model: "glm", durationMs: 2000, usage: { input: 50, output: 10, turns: 1 } }),
	]);
	assert.equal(s.runs, 4);
	assert.deepEqual(s.byModel, [
		{ provider: "lmstudio", model: "qwen", runs: 3, failed: 1, avgMs: 2000, avgInput: 200, avgOutput: 30, avgReasoning: 5 },
		{ provider: "opencode", model: "glm", runs: 1, failed: 0, avgMs: 2000, avgInput: 50, avgOutput: 10, avgReasoning: 0 },
	]);
	assert.deepEqual(s.byTool, [
		{ name: "project", uses: 2, failed: 1, avgMs: 50 },
		{ name: "fetch_url", uses: 1, failed: 0, avgMs: 500 },
	]);
	assert.deepEqual(s.failingTools, [{ name: "project", failed: 1, total: 2 }]);
	// Sin respuestas, tablas vacías y medias en cero.
	assert.deepEqual(summarizeRuns([]), { runs: 0, failed: 0, avgMs: 0, failingTools: [], byModel: [], byTool: [], totalCost: 0 });
});

test("registro: primera palabra media y coste por modelo; el total solo suma lo que se paga por token", () => {
	const s = summarizeRuns([
		entry({ provider: "opencode", model: "kimi", firstTextMs: 800, cost: 0.002 }),
		entry({ provider: "opencode", model: "kimi", firstTextMs: 1200, cost: 0.003 }),
		// Detenida: su primera palabra no cuenta para la media, pero lo gastado sí se paga.
		entry({ provider: "opencode", model: "kimi", firstTextMs: 9000, cost: 0.001, outcome: "cancelled" }),
		entry({ provider: "opencode-go", model: "glm", firstTextMs: 500, cost: 0.004, plan: true }),
		entry({ provider: "lmstudio", model: "qwen" }),
	]);
	const kimi = s.byModel.find((m) => m.model === "kimi");
	assert.equal(kimi?.avgFirstTextMs, 1000);
	assert.equal(kimi?.cost, 0.006);
	assert.equal(kimi?.plan, undefined);
	const glm = s.byModel.find((m) => m.model === "glm");
	assert.equal(glm?.plan, true);
	assert.equal(glm?.cost, 0.004);
	const qwen = s.byModel.find((m) => m.model === "qwen");
	assert.equal(qwen?.cost, undefined);
	assert.equal(qwen?.avgFirstTextMs, undefined);
	assert.equal(s.totalCost, 0.006);
});
