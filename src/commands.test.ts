import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, parseCommand, plainText } from "./commands.js";

test("los comandos responden en español y aceptan el nombre en inglés", () => {
	const help = parseCommand("/ayuda");
	assert.equal(help?.executed, true);
	for (const c of COMMANDS) assert.ok(help!.content.includes(c.usage ?? `/${c.name}`), `falta ${c.name} en /ayuda`);
	assert.equal(parseCommand("/help")?.content, help?.content);
	assert.match(parseCommand("/estado")?.content ?? "", /Modelo:/);
	assert.match(parseCommand("  /STATUS ")?.content ?? "", /Modelo:/);
});

test("lo que no es un comando va al modelo", () => {
	assert.equal(parseCommand("hola"), null);
	assert.equal(parseCommand("/home/jhon/notas.txt ¿qué pone?"), null); // una ruta
	assert.equal(parseCommand("/2024 fue un buen año"), null);
});

test("comando desconocido: lo dice en vez de fingir que lo hizo", () => {
	assert.match(parseCommand("/compactar")?.content ?? "", /No conozco el comando/);
	// /nuevo no puede borrar el chat desde el servidor: explica cómo hacerlo.
	assert.match(parseCommand("/nuevo")?.content ?? "", /Nuevo chat/);
});

test("plainText quita el formato para la terminal", () => {
	assert.equal(plainText("**Modelo:** `qwen3:8b`"), "Modelo: qwen3:8b");
});
