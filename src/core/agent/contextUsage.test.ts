import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "./Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { measureContext, sanitizeContextReport, scaleParts, toolTokens, type ContextPart } from "./contextUsage.js";
import { buildContext } from "./ContextBuilder.js";
import { extractCatalog } from "../llm/catalog.js";

const tool = (name: string, description = "x".repeat(70)): ToolDef => ({ type: "function", function: { name, description } });
const msg = (role: "user" | "assistant", chars: number): Message => ({ role, content: "x".repeat(chars) });
const sum = (parts: ContextPart[]) => parts.reduce((n, p) => n + p.tokens, 0);

test("toolTokens separa las herramientas de Shiro de las de servidores MCP", () => {
	const shiro = toolTokens([tool("search_web"), tool("fetch_url")]);
	assert.ok(shiro.tools > 0);
	assert.equal(shiro.mcp, 0);
	const mixed = toolTokens([tool("search_web"), tool("mcp__github__list_issues")]);
	assert.ok(mixed.mcp > 0);
	assert.ok(mixed.tools < shiro.tools);
});

test("scaleParts reparte el total real en proporción y suma justo", () => {
	const parts: ContextPart[] = [
		{ id: "messages", tokens: 100 },
		{ id: "instructions", tokens: 50 },
		{ id: "tools", tokens: 0 },
		{ id: "memory", tokens: 25 },
	];
	const scaled = scaleParts(parts, 1001);
	assert.equal(sum(scaled), 1001);
	assert.equal(scaled.find((p) => p.id === "tools")!.tokens, 0);
	// Mantiene las proporciones (redondeado).
	assert.ok(Math.abs(scaled[0].tokens - 572) <= 1);
	assert.ok(Math.abs(scaled[1].tokens - 286) <= 1);
	// Sin estimación no inventa nada.
	assert.equal(sum(scaleParts([{ id: "messages", tokens: 0 }], 500)), 0);
});

test("measureContext usa el total que contó el modelo y deja solo las partes con algo", () => {
	const report = measureContext({
		sections: { instructions: 3500, memory: 700, project: 0, skills: 0 },
		history: [msg("user", 350), msg("assistant", 350)],
		totalMessages: 6,
		tools: [tool("search_web")],
		toolResultChars: 1400,
		realInput: 2000,
		limit: 40960,
	});
	assert.equal(report.used, 2000);
	assert.equal(report.exact, true);
	assert.equal(report.limit, 40960);
	assert.equal(sum(report.parts), 2000);
	assert.deepEqual(
		report.parts.map((p) => p.id),
		["messages", "instructions", "tools", "memory", "toolResults"],
	);
	// Se enviaron 2 de 6 mensajes: el resto no cupo.
	assert.equal(report.sent, 2);
	assert.equal(report.total, 6);
	assert.equal(report.preview, undefined);
});

test("measureContext sin datos del modelo estima por el largo y lo marca", () => {
	const report = measureContext({
		sections: { instructions: 350, memory: 0, project: 0, skills: 0 },
		history: [],
		totalMessages: 0,
		tools: [],
		preview: true,
	});
	assert.equal(report.exact, false);
	assert.equal(report.preview, true);
	assert.equal(report.used, 100);
	assert.equal(report.limit, undefined);
	assert.deepEqual(report.parts, [{ id: "instructions", tokens: 100 }]);
});

test("sanitizeContextReport acepta solo números válidos y partes conocidas", () => {
	assert.equal(sanitizeContextReport(null), undefined);
	assert.equal(sanitizeContextReport({ used: 0 }), undefined);
	const clean = sanitizeContextReport({
		used: 1234.4,
		limit: -5,
		exact: "sí",
		parts: [{ id: "messages", tokens: 1000 }, { id: "<img>", tokens: 5 }, { id: "tools", tokens: "mucho" }, null],
		sent: 3,
		total: 9,
		extra: "no",
	});
	assert.deepEqual(clean, { used: 1234, exact: false, parts: [{ id: "messages", tokens: 1000 }], sent: 3, total: 9 });
});

test("buildContext reparte el system prompt en partes que suman su largo", () => {
	const { system, sections } = buildContext({
		goal: "hola",
		agentName: "Shiro",
		tokenBudget: 8000,
		userProfile: { userName: "Jhon", about: "Le gusta programar" },
		workspaceContext: "## MEMORY.md\nRecuerda el café sin azúcar.",
	});
	assert.equal(sections.instructions + sections.memory + sections.project + sections.skills, system.length);
	assert.ok(sections.memory > "Recuerda el café sin azúcar.".length);
	assert.equal(sections.project, 0);
	assert.ok(sections.instructions > 0);
});

test("El catálogo de models.dev guarda el tamaño de contexto", () => {
	const catalog = extractCatalog({
		opencode: { npm: "@ai-sdk/openai-compatible", models: { "kimi-k3": { name: "Kimi K3", limit: { context: 262144, output: 32768 } }, otro: { name: "Otro" } } },
	});
	assert.equal(catalog.providers.opencode?.["kimi-k3"].context, 262144);
	assert.equal(catalog.providers.opencode?.otro.context, undefined);
});
