import { test } from "node:test";
import { strictEqual } from "node:assert";
import { MemoryManager } from "./MemoryManager.js";

test("MemoryManager: aislamiento entre instancias (una no ve eventos de la otra)", () => {
	const mem1 = new MemoryManager({ shortWindow: 10, summarizeEvery: 100 });
	const mem2 = new MemoryManager({ shortWindow: 10, summarizeEvery: 100 });
	mem1.push({ type: "decision", timestamp: new Date().toISOString(), runId: "r1", payload: { goal: "A" } });
	mem2.push({ type: "decision", timestamp: new Date().toISOString(), runId: "r2", payload: { goal: "B" } });
	strictEqual(mem1.getRecent(5).length, 1);
	strictEqual(mem2.getRecent(5).length, 1);
	strictEqual(mem1.getRecent(5)[0].payload.goal, "A");
	strictEqual(mem2.getRecent(5)[0].payload.goal, "B");
});
