import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTools, runAgent } from "./Agent.js";
import { getConfig } from "../../config/config.js";
import { activeModelTuning } from "../llm/providers.js";
import { CODE_TOOLS, HACKING_TOOLS, PC_TOOLS, PLAN_TOOLS, planToolsFor, WINDOWS_ONLY_TOOLS } from "../tools/ToolRegistry.js";
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

test("en Chat con un modelo local (perfil lite) también tiene los ayudantes de la Oficina", () => {
	if (activeModelTuning().toolProfile === "full") return;
	assert.ok(resolveTools(undefined, true, true)?.includes("delegate"));
});

test("los modos y permisos se validan, y al planear las acciones mixtas se limitan a lectura", () => {
	assert.equal(parseChatMode("hacking"), "hacking");
	assert.equal(parseChatMode("code"), "code");
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

test("Code programa y usa habilidades, sin las herramientas de seguridad", () => {
	const code = resolveTools(CODE_TOOLS, true, true, false, undefined, "code");
	for (const tool of ["project", "write_file", "git", "exec", "terminal", "delegate", "browser", "use_skill", "claude_code"]) assert.ok(code?.includes(tool), tool);
	assert.equal(code?.includes("cve_search"), false);
	const plan = resolveTools(planToolsFor("code"), true, true, false, undefined, "code", true);
	assert.deepEqual(plan, PLAN_TOOLS);
});

test("Hacking prueba la seguridad y usa habilidades; al planear solo se recibe lectura, en cualquier modo", () => {
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

test("el modo ahorro no quita a Hacking sus herramientas", async () => {
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

test("planear deja buscar archivos por nombre y bloquea project edit antes de ejecutarlo", async () => {
	assert.equal(isPlanToolCall("project", { action: "find", query: "x" }), true);
	assert.equal(isPlanToolCall("project", { action: "edit" }), false);
	assert.ok(PLAN_TOOLS.includes("todo") && CODE_TOOLS.includes("todo") && HACKING_TOOLS.includes("todo"));
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_messages, _defs, exec) => {
			const r = await exec("project", { action: "edit", path: "Subidos/a.ts", old_text: "a", new_text: "b" });
			return r.ok ? r.content : (r.error ?? "La herramienta falló");
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const out = await runAgent("cambia este archivo", { llm, agentName: "Shiro", permissions: "plan", allowedTools: PLAN_TOOLS, mcp: false });
	assert.match(out, /Estás planeando: es solo lectura/i);
});

test("el entorno y la guía van solo donde se puede pedir permiso; el modelo sabe qué hizo antes y cuánto cabe", async () => {
	const seen: { system: string; last: string; tools: string[]; opts: { resultChars?: number; contextTokens?: number } | undefined }[] = [];
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (messages, defs, _exec, opts) => {
			seen.push({ system: String(messages[0]?.content), last: String(messages[messages.length - 1]?.content), tools: defs.map((d) => d.function.name), opts });
			return "Respuesta de prueba.";
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const base = { llm, agentName: "Shiro", mcp: false, mode: "code" as const, allowedTools: CODE_TOOLS };
	const conversation = [
		{ role: "user" as const, content: "revisa el fallo" },
		{ role: "assistant" as const, content: "Está en a.ts.", tools: [{ name: "project", label: "Leyendo a.ts", ok: true }] },
		{ role: "user" as const, content: "sigue" },
	];
	await runAgent("sigue", { ...base, approver: async () => true, conversation });
	await runAgent("hola", base);
	await runAgent("hola", { ...base, approver: async () => true, subagent: { boss: "Shiro" }, conversation });
	const [web, telegram, helper] = seen;
	assert.match(web!.system, /## Cómo trabajas\n/);
	assert.match(web!.system, /## Entorno\n- Sistema: /);
	assert.match(web!.system, /Modo Code\. Permisos: Preguntar/);
	assert.match(web!.system, /## Qué herramienta usar\n/);
	// Lo que hizo antes va pegado al mensaje nuevo, no arriba en las instrucciones.
	assert.match(web!.last, /^\[Nota del sistema; no la escribió el usuario\]\n## Lo que hiciste en tu respuesta anterior\n[\s\S]*- ✓ Leyendo a\.ts\n\[Fin de la nota\]\n\nsigue$/);
	assert.doesNotMatch(web!.system, /Lo que hiciste en tu respuesta anterior/);
	assert.ok(web!.tools.includes("todo"));
	assert.equal(typeof web!.opts?.resultChars, "number");
	assert.ok((web!.opts?.resultChars ?? 0) <= 12_000);
	// Sin a quién pedir permiso (Telegram, WhatsApp): el método sí, pero nada de cómo es el equipo.
	assert.match(telegram!.system, /## Cómo trabajas\n/);
	assert.doesNotMatch(telegram!.system, /## Entorno|## Qué herramienta usar/);
	// Un ayudante: sin lista de tareas ni otros ayudantes, y sin lo que hizo su jefe antes.
	assert.ok(!helper!.tools.includes("todo") && !helper!.tools.includes("delegate"));
	assert.match(helper!.system, /## Entorno\n/);
	assert.doesNotMatch(helper!.last, /Lo que hiciste en tu respuesta anterior/);
});

test("la lista de tareas llega a quien la pinta y se queda en la respuesta", async () => {
	const lists: unknown[] = [];
	const llm: LLMClient = {
		chat: async () => "ok",
		chatWithTools: async (_messages, _defs, exec) => {
			const a = await exec("todo", { items: [{ text: "Leer", status: "in_progress" }, { content: "Arreglar", status: "pending" }] });
			const b = await exec("todo", { todos: [{ text: "Leer", status: "completed" }, { text: "Arreglar", status: "in-progress" }] });
			return `${a.ok ? a.content : a.error} | ${b.ok ? b.content : b.error}`;
		},
		getConfig: () => ({ provider: "ollama", model: "qwen3:8b", baseUrl: "http://localhost:11434", local: true }),
	};
	const out = await runAgent("arregla el fallo", { llm, agentName: "Shiro", mcp: false, mode: "code", allowedTools: CODE_TOOLS, approver: async () => true, onTodo: (items) => lists.push(items) });
	assert.match(out, /0 de 2 hechas\. Ahora: «Leer»\. \| Lista guardada: 1 de 2 hechas\. Ahora: «Arreglar»\./);
	assert.deepEqual(lists, [
		[
			{ text: "Leer", status: "in_progress" },
			{ text: "Arreglar", status: "pending" },
		],
		[
			{ text: "Leer", status: "done" },
			{ text: "Arreglar", status: "in_progress" },
		],
	]);
});
