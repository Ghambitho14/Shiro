import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKeySequence } from "./keys.js";
import { classifyOpenTarget } from "./pc.js";
import { describeRiskyAction } from "../tools/approval.js";
import { modelSupportsVision } from "../llm/providers.js";
import { toolSchemas } from "../tools/schemas.js";
import { describeToolUse } from "../tools/ToolRegistry.js";

test("atajos de teclado en español e inglés", () => {
	assert.deepEqual(parseKeySequence("ctrl+c")[0].vks, [0x11, 0x43]);
	assert.deepEqual(parseKeySequence("Alt + Tab")[0].vks, [0x12, 0x09]);
	assert.deepEqual(parseKeySequence("win+d")[0].vks, [0x5b, 0x44]);
	assert.deepEqual(parseKeySequence("intro")[0].vks, [0x0d]);
	assert.deepEqual(parseKeySequence("Mayús+Supr")[0].vks, [0x10, 0x2e]);
	assert.deepEqual(parseKeySequence("ctrl++")[0].vks, [0x11, 0xbb]);
	assert.deepEqual(parseKeySequence("f5")[0].vks, [0x74]);
	const seq = parseKeySequence("ctrl+a, supr");
	assert.equal(seq.length, 2);
	assert.deepEqual(seq[1].vks, [0x2e]);
	assert.throws(() => parseKeySequence("ctrl+teclarara"), /No reconozco/);
	assert.throws(() => parseKeySequence(""), /ninguna tecla/);
});

test("qué se quiere abrir: web, carpeta, app, archivo", () => {
	assert.deepEqual(classifyOpenTarget("youtube.com"), { kind: "url", value: "https://youtube.com" });
	assert.equal(classifyOpenTarget("https://a.com/x?y=1&z=2").kind, "url");
	assert.equal(classifyOpenTarget("mis descargas").kind, "folder");
	assert.equal(classifyOpenTarget("Documentos").kind, "folder");
	assert.equal(classifyOpenTarget("la calculadora").kind, "system");
	assert.deepEqual(classifyOpenTarget("Spotify"), { kind: "app", value: "spotify" });
	assert.deepEqual(classifyOpenTarget("vscode"), { kind: "app", value: "visual studio code" });
	// "notepad.exe" o "informe.pdf" no son webs.
	assert.equal(classifyOpenTarget("notepad.exe").kind, "app");
	assert.equal(classifyOpenTarget("informe.pdf").kind, "app");
	const exe = classifyOpenTarget("C:/Programas/x.exe");
	assert.equal(exe.kind === "path" && exe.executable, true);
	const doc = classifyOpenTarget("C:/Users/yo/notas.txt");
	assert.equal(doc.kind === "path" && !doc.executable, true);
	const uri = classifyOpenTarget("ms-settings:display");
	assert.equal(uri.kind === "uri" && uri.safe, true);
	const unknown = classifyOpenTarget("file:///c:/x");
	assert.equal(unknown.kind === "uri" && !unknown.safe, true);
});

test("control del PC: qué pide permiso y qué no", () => {
	// Sin permiso: cosas inofensivas.
	assert.equal(describeRiskyAction("pc_open", { target: "Spotify" }), null);
	assert.equal(describeRiskyAction("pc_open", { target: "youtube.com" }), null);
	assert.equal(describeRiskyAction("pc_media", { action: "volume_up" }), null);
	assert.equal(describeRiskyAction("pc_windows", { action: "close", title: "Bloc de notas" }), null);
	assert.equal(describeRiskyAction("pc_mouse", { action: "move", x: 1, y: 2 }), null);
	assert.equal(describeRiskyAction("pc_power", { action: "lock" }), null);
	assert.equal(describeRiskyAction("pc_clipboard", { action: "write", text: "x" }), null);
	// Con permiso: ejecutar archivos, teclado, clics, leer portapapeles, cerrar a la fuerza, apagar.
	assert.ok(describeRiskyAction("pc_open", { target: "C:/x/programa.exe" }));
	assert.ok(describeRiskyAction("pc_open", { target: "file:///c:/x" }));
	assert.ok(describeRiskyAction("pc_open", { target: "instalar.bat" }));
	assert.equal(describeRiskyAction("pc_open", { target: "notepad.exe" }), null);
	assert.ok(describeRiskyAction("pc_keyboard", { text: "hola" }));
	assert.ok(describeRiskyAction("pc_mouse", { action: "click", x: 10, y: 10 }));
	assert.ok(describeRiskyAction("pc_clipboard", { action: "read" }));
	assert.ok(describeRiskyAction("pc_processes", { action: "kill", name: "chrome" }));
	assert.match(describeRiskyAction("pc_power", { action: "shutdown" }) ?? "", /Apagar el PC en 1 min/);
	assert.ok(describeRiskyAction("pc_power", { action: "sleep" }));
});

test("detección de modelos con visión", () => {
	assert.equal(modelSupportsVision("qwen2.5vl:7b", "auto"), true);
	assert.equal(modelSupportsVision("llama3.2-vision", "auto"), true);
	assert.equal(modelSupportsVision("gemma3:12b", "auto"), true);
	assert.equal(modelSupportsVision("openai/gpt-4o-mini", "auto"), true);
	assert.equal(modelSupportsVision("qwen/qwen2.5-vl-72b-instruct", "auto"), true);
	assert.equal(modelSupportsVision("qwen3:8b", "auto"), false);
	assert.equal(modelSupportsVision("qwen3:8b", "on"), true);
	assert.equal(modelSupportsVision("gpt-4o", "off"), false);
});

test("schemas del PC aceptan números como texto y exigen lo necesario", () => {
	const media = toolSchemas.pc_media.safeParse({ action: "set_volume", value: "40" });
	assert.equal(media.success && media.data.value, 40);
	assert.equal(toolSchemas.pc_keyboard.safeParse({}).success, false);
	assert.equal(toolSchemas.pc_keyboard.safeParse({ keys: "enter" }).success, true);
	assert.equal(toolSchemas.pc_power.safeParse({ action: "explotar" }).success, false);
});

test("descripción legible de lo que hace cada herramienta", () => {
	assert.equal(describeToolUse("pc_open", { target: "Spotify" }), "Abriendo Spotify");
	assert.equal(describeToolUse("pc_media", { action: "set_volume", value: 30 }), "Poniendo el volumen al 30%");
	assert.match(describeToolUse("search_web", { query: "clima" }), /Buscando en internet: clima/);
});
