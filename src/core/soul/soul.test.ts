import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-soul-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { setConfig } = await import("../../config/config.js");
const { DEFAULT_SYSTEM_PROMPT, getSoul, renderSystemPrompt } = await import("./soul.js");
const { EDITABLE_NOTES, buildWorkspaceContext, readNote, writeNote } = await import("../../workspace.js");

test("las instrucciones base por defecto llevan el nombre y la fecha", () => {
	const soul = getSoul("Aku");
	assert.match(soul, /^Eres Aku, un asistente con acceso a herramientas/);
	assert.match(soul, new RegExp(String(new Date().getFullYear())));
	assert.doesNotMatch(soul, /\{\{/);
	assert.match(renderSystemPrompt("Hola {{ Nombre }}, hoy es {{fecha}}. {{otra}}", "Aku"), /^Hola Aku, hoy es .+\. \{\{otra\}\}$/);
});

test("las instrucciones base se pueden cambiar y volver a las originales", () => {
	setConfig({ systemPrompt: "Eres {{nombre}}, un pirata. Respondes siempre en verso." });
	assert.equal(getSoul("Aku"), "Eres Aku, un pirata. Respondes siempre en verso.");
	// También en el modo solo texto.
	assert.equal(getSoul("Aku", true), "Eres Aku, un pirata. Respondes siempre en verso.");
	setConfig({ systemPrompt: undefined });
	assert.equal(getSoul("Aku"), renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, "Aku"));
});

test("SOUL.md, TOOLS.md y MEMORY.md se editan y se restauran", () => {
	assert.equal(readNote("soul"), EDITABLE_NOTES.soul.template);
	writeNote("soul", "# Quién eres\r\n\r\nHablas siempre de tú y con humor.\r\n\r\n");
	assert.equal(readNote("soul"), "# Quién eres\n\nHablas siempre de tú y con humor.\n");
	assert.match(buildWorkspaceContext(), /Hablas siempre de tú y con humor/);
	writeNote("memory", "Mi perro se llama Toby.");
	assert.match(buildWorkspaceContext({ includeLongTermMemory: true }), /Toby/);
	writeNote("soul");
	assert.equal(readNote("soul"), EDITABLE_NOTES.soul.template);
	assert.equal(writeNote("tools", "   "), EDITABLE_NOTES.tools.template);
});
