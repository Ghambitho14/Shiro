import { test } from "node:test";
import { strictEqual } from "node:assert";
import { summarize } from "./Summarizer.js";
import type { AgentEvent } from "../agent/Types.js";

test("summarize produces summary and keyFacts", () => {
	const events: AgentEvent[] = [
		{
			type: "observation",
			timestamp: new Date().toISOString(),
			runId: "r1",
			payload: { content: "File content here" },
		},
		{
			type: "decision",
			timestamp: new Date().toISOString(),
			runId: "r1",
			payload: { reason: "User asked for summary" },
		},
	];
	const out = summarize(events);
	strictEqual(typeof out.summary, "string");
	strictEqual(out.summary.length > 0, true);
	strictEqual(Array.isArray(out.keyFacts), true);
	strictEqual(out.keyFacts.length, 1);
	strictEqual(out.keyFacts[0], "User asked for summary");
	strictEqual(Array.isArray(out.openTasks), true);
});

test("summarize empty events returns default summary", () => {
	const out = summarize([]);
	strictEqual(out.summary, "Sin resumen.");
	strictEqual(out.keyFacts.length, 0);
});
