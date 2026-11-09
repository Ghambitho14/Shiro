import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTools, runAgent } from "./Agent.js";
import { getConfig } from "../../config/config.js";
import { activeModelTuning } from "../llm/providers.js";
import { HACKING_TOOLS, PC_TOOLS, PLAN_TOOLS, planToolsFor, WINDOWS_ONLY_TOOLS } from "../tools/ToolRegistry.js";
import { isPlanToolCall, parseChatMode, parsePermissionMode } from "./chatMode.js";
import type { LLMClient } from "../llm/LLMClient.js";

const hasPc = (tools: string[] | undefined) => (tools ?? PC_TOOLS).some((t) => PC_TOOLS.includes(t));

test("sin forma de pedir permiso (WhatsApp, Telegram, cron) no se ofrece el control del PC", (t) => {
	if (!getConfig().pcControl) return t.skip("pcControl está desactivado en data/config.json");
	assert.equal(hasPc(resolveTools(undefined, false, false)), false);
	assert.equal(hasPc(resolveTools(undefined, true, false)), false);
});

test("en la web o la terminal (con approver) sí se ofrece, también a modelos locales (perfil lite)", (t) => {
	if (!getConfig().pcControl) return t.skip("pcControl está desactivado en data/config.json");
	const full = resolveTools(undefined, false, true);
	assert.equal(full === undefined || hasPc(full), true);
	const lite = resolveTools(undefined, true, true);
	if (activeModelTuning().toolProfile !== "full") {
		assert.ok(lite?.includes("pc_open"));
		assert.ok(lite?.includes("pc_media"));
	}
});

test("los modos y permisos se validan, y al planear las acciones mixtas se limitan a lectura", () => {
	assert.equal(parseChatMode("hacking"), "hacking");
	// El antiguo modo Code ahora es CodeHacking.
	assert.equal(parseChatMode("code"), "hacking");
	// Plan ya no es un modo: es un permiso que vale en cualquiera.
	assert.equal(parseChatMode("plan"), "chat");
	assert.equal(parseChatMode("cualquier cosa"), "chat");
	assert.equal(parseChatMode(undefined), "chat");
	assert.equal(parsePermissionMode("plan"), "plan");
	assert.equal(parsePermissionMode("auto"), "auto");
	assert.equal(parsePermissionMode("bypass"), "bypass");
	assert.equal(parsePermissionMode("admin"), "ask");
	assert.equal(parsePermissionMode(undefined), "ask");
	assert.equal(isPlanToolCall("project", { action: "read" }), true);
	assert.equal(isPlanToolCall("project", { action: "search" }), true);
	assert.equal(isPlanToolCall("project", { action: "write" }), false);
	assert.equal(isPlanToolCall("terminal", { action: "read" }), true);
	assert.equal(isPlanToolCall("terminal", { action: "run" }), false);
	assert.equal(isPlanToolCall("terminal", { action: "write", text: "hola" }), false);
});

test("CodeHacking programa, hackea y usa habilidades; al planear solo se recibe lectura, en cualquier modo", () => {
	const all = resolveTools(HACKING_TOOLS, true, true, false, undefined, "hacking");
	for (const tool of ["write_file", "git", "exec", "terminal", "delegate", "cve_search", "browser", "use_skill"]) assert.ok(all?.includes(tool), tool);
	const chatPlan = resolveTools(planToolsFor("chat"), true, true, false, undefined, "chat", true);
	assert.deepEqual(chatPlan, PLAN_TOOLS);
	const hacking = resolveTools(planToolsFor("hacking"), true, true, false, undefined, "hacking", true);
	assert.ok(hacking?.includes("cve_search"));
	for (const tool of ["write_file", "write_file_system", "memory_add", "exec", "terminal", "git", "claude_code"]) {
		assert.equal(hacking?.includes(tool), false, tool);
	}
});

test("fuera de Windows no se ofrecen las herramientas que solo funcionan ahí", (t) => {
	const real = Object.getOwnPropertyDescriptor(process, "platform")!;
	t.after(() => Object.defineProperty(process, "platform", real));
	Object.defineProperty(process, "platform", { ...real, value: "linux" });
	const tools = resolveTools(HACKING_TOOLS, true, true, false, undefined, "hacking")!;
	assert.ok(tools.includes("terminal"));
	const chat = resolveTools(undefined, false, true, false)!;
	for (const tool of WINDOWS_ONLY_TOOLS) assert.equal(chat.includes(tool), false, tool);
	if (getConfig().pcControl) for (const tool of ["pc_open", "pc_system", "browser", "terminal"]) assert.ok(chat.includes(tool), tool);
});

test("los límites del modo ahorro solo se piden en Chat", async () => {
	const seen: unknown[] = [];
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_m, _d, _e, opts) => {
			seen.push(opts?.saverLimits);
			return "Respuesta de prueba.";
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const base = { llm, agentName: "Shiro", mcp: false, approver: async () => true };
	await runAgent("hola", { ...base, mode: "chat" });
	await runAgent("hola", { ...base, mode: "hacking", allowedTools: HACKING_TOOLS });
	await runAgent("hola", { ...base, mode: "chat", permissions: "plan", allowedTools: PLAN_TOOLS });
	assert.deepEqual(seen, [true, false, false]);
});

test("Más razonamiento llega al modelo solo si se pidió", async () => {
	const seen: unknown[] = [];
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_m, _d, _e, opts) => {
			seen.push(opts?.thinking);
			return "ok";
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const base = { llm, agentName: "Shiro", mode: "hacking" as const, allowedTools: HACKING_TOOLS, mcp: false, approver: async () => true };
	await runAgent("hola", base);
	await runAgent("hola", { ...base, thinking: "high" });
	assert.deepEqual(seen, [undefined, "high"]);
});

test("el modo ahorro no quita a CodeHacking las herramientas de programación", async () => {
	let offered: string[] = [];
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_messages, defs) => {
			offered = defs.map((d) => d.function.name);
			return "Respuesta de prueba.";
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const out = await runAgent("hola", {
		llm,
		agentName: "Shiro",
		mode: "hacking",
		allowedTools: HACKING_TOOLS,
		mcp: false,
		approver: async () => true,
	});
	assert.equal(out, "Respuesta de prueba.");
	for (const tool of ["write_file", "git", "exec", "terminal", "delegate"]) assert.ok(offered.includes(tool), tool);
});

test("planear bloquea project write antes de ejecutar la herramienta", async () => {
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_messages, _defs, exec) => {
			const r = await exec("project", { action: "write", path: "Subidos/prueba.ts", content: "no debe escribirse" });
			return r.ok ? r.content : (r.error ?? "La herramienta falló");
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const out = await runAgent("escribe este archivo", {
		llm,
		agentName: "Shiro",
		permissions: "plan",
		allowedTools: PLAN_TOOLS,
		mcp: false,
	});
	assert.match(out, /Estás planeando: es solo lectura/i);
	assert.match(out, /Preguntar o Automático/);
});
