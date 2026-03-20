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
	strictEqual(out.system.includes("Mensaje del usuario"), true);
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

test("buildContext limits tools manifest by allowedTools", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		shortMemory: memory,
		tokenBudget: 2000,
		allowedTools: ["search_web"],
	});

	strictEqual(out.system.includes("## Herramientas disponibles"), true);
	const idx = out.system.indexOf("## Herramientas disponibles");
	strictEqual(idx >= 0, true);
	const toolSection = out.system.slice(idx);

	strictEqual(toolSection.includes("search_web:"), true);
	strictEqual(toolSection.includes("fetch_url:"), false);
});
