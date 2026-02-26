import { test } from "node:test";
import { strictEqual } from "node:assert";
import { detectLoop } from "./LoopDetector.js";
import type { AgentEvent } from "../agent/Types.js";

function ev(type: AgentEvent["type"], payload: Record<string, unknown>): AgentEvent {
	return {
		type,
		timestamp: new Date().toISOString(),
		runId: "r1",
		payload,
	};
}

test("detectLoop ok with few events", () => {
	strictEqual(detectLoop([]).signal, "ok");
	strictEqual(detectLoop([ev("tool_call", { name: "read_file" })]).signal, "ok");
});

test("detectLoop same_action after 3 same tool calls", () => {
	const events: AgentEvent[] = [
		ev("tool_call", { name: "read_file" }),
		ev("tool_call", { name: "read_file" }),
		ev("tool_call", { name: "read_file" }),
	];
	const r = detectLoop(events);
	strictEqual(r.signal, "same_action");
	strictEqual(r.detail, "read_file");
});

test("detectLoop same_error after 2 same errors", () => {
	const events: AgentEvent[] = [
		ev("error", { content: "File not found" }),
		ev("error", { content: "File not found" }),
	];
	const r = detectLoop(events);
	strictEqual(r.signal, "same_error");
});
