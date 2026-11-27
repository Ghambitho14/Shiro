import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_TOOLS, getAllToolNames, HACKING_TOOLS, LITE_TOOLS, PC_TOOLS, PLAN_TOOLS, planToolsFor, WINDOWS_ONLY_TOOLS } from "./ToolRegistry.js";
import { alwaysAsksUser, canRememberApproval, isHardToUndo } from "./approval.js";
import { isExternalTool, wrapExternal } from "./untrusted.js";
import { isPlanToolCall } from "../agent/chatMode.js";
import { selectToolsByIntent } from "../agent/toolIntent.js";
import { SCHEDULED_TOOLS } from "../scheduler/runTask.js";

/**
 * Red de seguridad de la pieza 3 (permisos declarados en cada herramienta, 2026-11-27): cómo se comportaban
 * las listas de herramientas ANTES de calcularlas desde `policy`. Si esta prueba falla, una herramienta cambió
 * de permisos: si fue a propósito, se actualiza aquí; si no, es un error.
 */
const EXPECTED = {
	"all": [
		"ask_user",
		"browser",
		"calculator",
		"calendar",
		"claude_code",
		"complete_reminder",
		"create_reminder",
		"cron_create",
		"cron_delete",
		"cron_list",
		"cron_toggle",
		"cve_search",
		"delegate",
		"describe_image",
		"draw",
		"email",
		"exec",
		"fetch_url",
		"get_time",
		"get_weather",
		"git",
		"list_dir",
		"list_dir_system",
		"list_reminders",
		"memory_add",
		"memory_search",
		"pc_clipboard",
		"pc_keyboard",
		"pc_media",
		"pc_mouse",
		"pc_open",
		"pc_power",
		"pc_processes",
		"pc_screenshot",
		"pc_system",
		"pc_windows",
		"pentest",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"sessions_history",
		"sessions_list",
		"terminal",
		"todo",
		"use_skill",
		"write_file",
		"write_file_system"
	],
	"lite": [
		"ask_user",
		"browser",
		"calculator",
		"calendar",
		"claude_code",
		"create_reminder",
		"cron_create",
		"cron_delete",
		"cron_list",
		"cve_search",
		"delegate",
		"draw",
		"email",
		"exec",
		"fetch_url",
		"get_time",
		"list_dir",
		"list_reminders",
		"memory_add",
		"memory_search",
		"pc_keyboard",
		"pc_media",
		"pc_open",
		"pc_power",
		"pc_screenshot",
		"pc_system",
		"pc_windows",
		"project",
		"read_file",
		"search_web",
		"terminal",
		"use_skill",
		"write_file"
	],
	"plan": [
		"ask_user",
		"calculator",
		"delegate",
		"fetch_url",
		"get_time",
		"list_dir",
		"list_dir_system",
		"list_reminders",
		"memory_search",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"sessions_history",
		"sessions_list",
		"todo",
		"use_skill"
	],
	"planHacking": [
		"ask_user",
		"calculator",
		"cve_search",
		"delegate",
		"fetch_url",
		"get_time",
		"list_dir",
		"list_dir_system",
		"list_reminders",
		"memory_search",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"sessions_history",
		"sessions_list",
		"todo",
		"use_skill"
	],
	"planCode": [
		"ask_user",
		"calculator",
		"delegate",
		"fetch_url",
		"get_time",
		"list_dir",
		"list_dir_system",
		"list_reminders",
		"memory_search",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"sessions_history",
		"sessions_list",
		"todo",
		"use_skill"
	],
	"hacking": [
		"ask_user",
		"browser",
		"calculator",
		"claude_code",
		"cve_search",
		"delegate",
		"draw",
		"exec",
		"fetch_url",
		"get_time",
		"git",
		"list_dir",
		"list_dir_system",
		"memory_add",
		"memory_search",
		"pentest",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"terminal",
		"todo",
		"use_skill",
		"write_file",
		"write_file_system"
	],
	"code": [
		"ask_user",
		"browser",
		"calculator",
		"claude_code",
		"delegate",
		"draw",
		"exec",
		"fetch_url",
		"get_time",
		"git",
		"list_dir",
		"list_dir_system",
		"memory_add",
		"memory_search",
		"project",
		"read_file",
		"read_file_system",
		"search_web",
		"terminal",
		"todo",
		"use_skill",
		"write_file",
		"write_file_system"
	],
	"windowsOnly": [
		"pc_clipboard",
		"pc_keyboard",
		"pc_media",
		"pc_mouse",
		"pc_power",
		"pc_processes",
		"pc_screenshot",
		"pc_windows"
	],
	"pc": [
		"browser",
		"claude_code",
		"pc_clipboard",
		"pc_keyboard",
		"pc_media",
		"pc_mouse",
		"pc_open",
		"pc_power",
		"pc_processes",
		"pc_screenshot",
		"pc_system",
		"pc_windows",
		"terminal"
	],
	"remember": [
		"browser",
		"pc_clipboard",
		"pc_keyboard",
		"pc_mouse",
		"pc_open"
	],
	"auto": [
		"claude_code",
		"exec",
		"git",
		"memory_add",
		"project",
		"read_file_system",
		"terminal",
		"write_file",
		"write_file_system"
	],
	"external": {
		"browser": "<<<CONTENIDO EXTERNO de una página del navegador",
		"calendar": "<<<CONTENIDO EXTERNO de el calendario (los eventos pueden venir de invitaciones de otros)",
		"cve_search": "<<<CONTENIDO EXTERNO de una base de datos de CVE (vulnerabilidades)",
		"delegate": "<<<CONTENIDO EXTERNO de tus ayudantes (pueden traer texto de webs)",
		"email": "<<<CONTENIDO EXTERNO de el correo (Gmail)",
		"fetch_url": "<<<CONTENIDO EXTERNO de una web",
		"search_web": "<<<CONTENIDO EXTERNO de una búsqueda en Internet"
	},
	"scheduled": [
		"calculator",
		"calendar",
		"cron_list",
		"cve_search",
		"email",
		"fetch_url",
		"get_time",
		"get_weather",
		"list_dir",
		"list_reminders",
		"memory_search",
		"project",
		"read_file",
		"search_web",
		"sessions_history",
		"sessions_list"
	],
	"planCalls": {
		"browser": [
			"read",
			"open",
			"scroll",
			"back",
			"screenshot"
		],
		"terminal": [
			"read"
		],
		"project": [
			"list",
			"find",
			"read",
			"search",
			"semantic",
			"undefined"
		]
	},
	"alwaysAsk": {
		"email": [
			"send"
		],
		"calendar": [
			"create"
		]
	},
	"intent": {
		"nada": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		],
		"archivos": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"describe_image",
			"draw",
			"fetch_url",
			"get_time",
			"list_dir",
			"list_dir_system",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"read_file",
			"read_file_system",
			"search_web",
			"terminal",
			"use_skill",
			"write_file",
			"write_file_system"
		],
		"recordatorios": [
			"ask_user",
			"calculator",
			"complete_reminder",
			"create_reminder",
			"cron_create",
			"cron_delete",
			"cron_list",
			"cron_toggle",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"list_reminders",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		],
		"google": [
			"ask_user",
			"calculator",
			"calendar",
			"cve_search",
			"delegate",
			"draw",
			"email",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"todo",
			"use_skill"
		],
		"clima": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"get_weather",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		],
		"pc": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"exec",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pc_clipboard",
			"pc_keyboard",
			"pc_media",
			"pc_mouse",
			"pc_open",
			"pc_power",
			"pc_processes",
			"pc_screenshot",
			"pc_system",
			"pc_windows",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		],
		"navegador": [
			"ask_user",
			"browser",
			"calculator",
			"cve_search",
			"delegate",
			"describe_image",
			"draw",
			"exec",
			"fetch_url",
			"get_time",
			"list_dir",
			"list_dir_system",
			"memory_add",
			"memory_search",
			"pc_clipboard",
			"pc_keyboard",
			"pc_media",
			"pc_mouse",
			"pc_open",
			"pc_power",
			"pc_processes",
			"pc_screenshot",
			"pc_system",
			"pc_windows",
			"pentest",
			"project",
			"read_file",
			"read_file_system",
			"search_web",
			"terminal",
			"use_skill",
			"write_file",
			"write_file_system"
		],
		"git": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"git",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		],
		"chats": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"sessions_history",
			"sessions_list",
			"terminal",
			"use_skill"
		],
		"tareas": [
			"ask_user",
			"calculator",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"todo",
			"use_skill"
		],
		"claude": [
			"ask_user",
			"calculator",
			"claude_code",
			"cve_search",
			"delegate",
			"draw",
			"fetch_url",
			"get_time",
			"memory_add",
			"memory_search",
			"pentest",
			"project",
			"search_web",
			"terminal",
			"use_skill"
		]
	}
} as const;

const sorted = (a: Iterable<string>) => [...a].sort();
const all = getAllToolNames();
const ACTIONS = ["list", "find", "read", "search", "semantic", "edit", "write", "run", "stop", "open", "scroll", "back", "screenshot", "click", "type", "close", "send", "draft", "create", undefined];
const TEXTS: Record<string, string> = { nada: "hola", archivos: "lee el archivo", recordatorios: "recuérdame mañana", google: "revisa mi correo", clima: "qué clima hace", pc: "sube el volumen", navegador: "abre https://x.com", git: "haz un commit", chats: "lo que hablamos", tareas: "investiga esto", claude: "arregla el código" };

test("las herramientas son las mismas", () => assert.deepEqual(sorted(all), EXPECTED.all));

test("listas por perfil y modo: lite, planear, Code, Hacking, solo Windows, PC", () => {
	assert.deepEqual(sorted(LITE_TOOLS), EXPECTED.lite);
	assert.deepEqual(sorted(PLAN_TOOLS), EXPECTED.plan);
	assert.deepEqual(sorted(planToolsFor("hacking")), EXPECTED.planHacking);
	assert.deepEqual(sorted(planToolsFor("code")), EXPECTED.planCode);
	assert.deepEqual(sorted(HACKING_TOOLS), EXPECTED.hacking);
	assert.deepEqual(sorted(CODE_TOOLS), EXPECTED.code);
	assert.deepEqual(sorted(WINDOWS_ONLY_TOOLS), EXPECTED.windowsOnly);
	assert.deepEqual(sorted(PC_TOOLS), EXPECTED.pc);
	assert.deepEqual(sorted(SCHEDULED_TOOLS), EXPECTED.scheduled);
});

test("permisos: recordar en el chat, Automático y preguntar siempre", () => {
	assert.deepEqual(sorted(all.filter((t) => canRememberApproval(t))), EXPECTED.remember);
	assert.deepEqual(sorted(all.filter((t) => !isHardToUndo(t, {}))), EXPECTED.auto);
	const asks = Object.fromEntries(all.map((t) => [t, ACTIONS.filter((a) => alwaysAsksUser(t, { action: a }))]).filter(([, v]) => v.length));
	assert.deepEqual(asks, EXPECTED.alwaysAsk);
});

test("contenido de afuera: qué herramientas y con qué fuente", () => {
	const ext = Object.fromEntries(all.filter((t) => isExternalTool(t)).sort().map((t) => [t, wrapExternal(t, "x").split(":")[0]]));
	assert.deepEqual(ext, EXPECTED.external);
});

test("planear: acciones de solo lectura", () => {
	const calls = Object.fromEntries(
		all.map((t) => [t, ACTIONS.filter((a) => isPlanToolCall(t, a === undefined ? {} : { action: a })).map(String)]).filter(([, v]) => v.length !== ACTIONS.length),
	);
	assert.deepEqual(calls, EXPECTED.planCalls);
});

test("modo ahorro: qué herramientas se ofrecen según el mensaje", () => {
	for (const [k, text] of Object.entries(TEXTS)) assert.deepEqual(sorted(selectToolsByIntent(all, [text])), EXPECTED.intent[k as keyof typeof EXPECTED.intent], k);
});

// ───────────── Coherencia de la `policy` (para las herramientas nuevas) ─────────────

test("coherencia: cada grupo del modo ahorro tiene herramientas", async () => {
	const { toolsInGroup } = await import("./toolPolicy.js");
	const groups = ["archivos", "recordatorios", "google", "clima", "pc", "navegador", "git", "chats", "tareas", "claude"] as const;
	for (const g of groups) assert.ok(toolsInGroup(g).length > 0, g);
});

test("coherencia: lo que pregunta siempre tiene tarjeta de permiso", async () => {
	const { describeRiskyAction } = await import("./approval.js");
	const { TOOLS } = await import("./toolDefinitions.js");
	// Sin tarjeta, requestApproval lo dejaría pasar sin preguntar y `alwaysAsk` no serviría de nada.
	for (const t of TOOLS) for (const action of t.policy.alwaysAsk ?? []) assert.ok(describeRiskyAction(t.name, { action }), `${t.name} ${action}`);
});

test("coherencia: tareas programadas sin control del PC; solo Windows es del PC", async () => {
	const { TOOLS } = await import("./toolDefinitions.js");
	for (const t of TOOLS) {
		if (t.policy.scheduled) assert.notEqual(t.category, "pc", `${t.name} es del PC y no hay a quién preguntar`);
		if (t.policy.windowsOnly) assert.equal(t.category, "pc", t.name);
		if (t.policy.defaultAction) assert.ok(t.policy.planActions, `${t.name}: defaultAction sin planActions`);
		if (t.policy.plan === "hacking") assert.ok(t.policy.modes?.includes("hacking"), t.name);
	}
});
