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
