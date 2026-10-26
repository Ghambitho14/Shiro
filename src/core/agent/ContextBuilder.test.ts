import { test } from "node:test";
import { strictEqual } from "node:assert";
import { buildContext } from "./ContextBuilder.js";
import { MemoryManager } from "../memory/MemoryManager.js";

test("buildContext respects token budget and includes soul", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		shortMemory: memory,
		tokenBudget: 2000,
	});
	strictEqual(typeof out.system, "string");
	strictEqual(out.system.length > 0, true);
	strictEqual(out.system.includes("TestAgent"), true);
	strictEqual(Array.isArray(out.messages), true);
	strictEqual(out.messages.length >= 1, true);
	strictEqual(out.messages[0].role, "user");
	strictEqual(out.messages[0].content, "List files");
});

test("buildContext with long memory includes summary", () => {
	const memory = new MemoryManager();
	memory.setLongTerm({ summary: "Previous session summary.", keyFacts: [], openTasks: [] });
	const out = buildContext({
		goal: "Continue",
		agentName: "A",
		shortMemory: memory,
		tokenBudget: 4000,
	});
	strictEqual(out.system.includes("Previous session summary"), true);
});

test("buildContext no duplica el manifiesto de tools (van por la API)", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		shortMemory: memory,
		tokenBudget: 2000,
	});

	strictEqual(out.system.includes("## Herramientas disponibles"), false);
});

test("buildContext añade las reglas de control del PC y del modo voz solo cuando tocan", () => {
	const memory = new MemoryManager();
	const base = { goal: "hola", agentName: "A", shortMemory: memory, tokenBudget: 4000 };
	const plain = buildContext(base).system;
	strictEqual(plain.includes("## Control del PC"), false);
	strictEqual(plain.includes("## Modo voz"), false);

	const pc = buildContext({ ...base, pcControl: true, vision: false }).system;
	strictEqual(pc.includes("## Control del PC"), true);
	strictEqual(pc.includes("pc_windows (action=list)"), true);
	strictEqual(buildContext({ ...base, pcControl: true, vision: true }).system.includes("pc_screenshot"), true);
	// En modo solo texto no hay herramientas: no se mencionan.
	strictEqual(buildContext({ ...base, pcControl: true, textOnly: true }).system.includes("## Control del PC"), false);

	strictEqual(buildContext({ ...base, voice: true }).system.includes("## Modo voz"), true);
});
