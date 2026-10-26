import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-soul-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { getConfig, setConfig } = await import("../../config/config.js");
const { DEFAULT_SYSTEM_PROMPT, getSoul, renderSystemPrompt } = await import("./soul.js");
const { EDITABLE_NOTES, INSTRUCTIONS_NOTE, buildWorkspaceContext, getWorkspaceDir, readNote, writeInstructions, writeNote } = await import("../../workspace.js");
const { getUserProfile, setUserProfile } = await import("../../user-profile.js");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");

test("las instrucciones base por defecto llevan el nombre y la fecha", () => {
	const soul = getSoul("Aku");
	assert.match(soul, /^Eres Aku, un asistente con acceso a herramientas/);
	assert.match(soul, new RegExp(String(new Date().getFullYear())));
	assert.doesNotMatch(soul, /\{\{/);
	assert.match(renderSystemPrompt("Hola {{ Nombre }}, hoy es {{fecha}}. {{otra}}", "Aku"), /^Hola Aku, hoy es .+\. \{\{otra\}\}$/);
});

test("las instrucciones base viven en Instrucciones.md: se cambian y vuelven a las originales", () => {
	const note = join(getWorkspaceDir(), INSTRUCTIONS_NOTE);
	writeInstructions("Eres {{nombre}}, un pirata. Respondes siempre en verso.");
	assert.equal(getSoul("Aku"), "Eres Aku, un pirata. Respondes siempre en verso.");
	// También en el modo solo texto.
	assert.equal(getSoul("Aku", true), "Eres Aku, un pirata. Respondes siempre en verso.");
	// Lo que se cambie a mano en la nota (en Obsidian) vale al momento.
	writeFileSync(note, "Eres {{nombre}}, un robot.\r\n", "utf-8");
	assert.equal(getSoul("Aku"), "Eres Aku, un robot.");
	writeInstructions();
	assert.equal(readFileSync(note, "utf-8"), DEFAULT_SYSTEM_PROMPT + "\n");
	assert.equal(getSoul("Aku"), renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, "Aku"));
});

test("las instrucciones de config.json y el viejo user-profile.json pasan a notas", () => {
	setConfig({ systemPrompt: "Eres {{nombre}}, el de antes." });
	mkdirSync(join(TMP, "data"), { recursive: true });
	const legacy = join(TMP, "data", "user-profile.json");
	writeFileSync(legacy, JSON.stringify({ userName: "Ghambitho", language: "Español", about: "Estudio ciberseguridad." }), "utf-8");
	assert.equal(getSoul("Aku"), "Eres Aku, el de antes.");
	assert.equal(getConfig().systemPrompt, undefined);
	assert.deepEqual(getUserProfile(), { userName: "Ghambitho", language: "Español", about: "Estudio ciberseguridad.", extra: undefined });
	assert.ok(!existsSync(legacy));
	writeInstructions();
});

test("«Sobre ti» es la nota Sobre mí.md, también editada a mano", () => {
	setUserProfile({ extra: "Directo y con humor." });
	const note = join(getWorkspaceDir(), "Sobre mí.md");
	const text = readFileSync(note, "utf-8");
	assert.match(text, /^---\nnombre: "Ghambitho"\nidioma: "Español"\n---\n# Sobre mí\n/);
	assert.match(text, /## Cómo quiero que respondas\nDirecto y con humor\./);
	writeFileSync(note, text.replace("Estudio ciberseguridad.", "Estudio ciberseguridad y redes."), "utf-8");
	assert.equal(getUserProfile().about, "Estudio ciberseguridad y redes.");
	// Sin los títulos de siempre, el texto cuenta como «qué saber de mí».
	writeFileSync(note, "---\nnombre: Jhon\n---\nMe gusta el café.\n", "utf-8");
	assert.deepEqual(getUserProfile(), { userName: "Jhon", language: undefined, about: "Me gusta el café.", extra: undefined });
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
