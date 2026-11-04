import { test } from "node:test";
import assert from "node:assert/strict";
import { getAllToolNames } from "../tools/ToolRegistry.js";
import { selectToolsByIntent } from "./toolIntent.js";

const ALL = [...getAllToolNames(), "mcp__notion__search"];

test("Modo ahorro: una pregunta simple no lleva las herramientas del PC ni del navegador", () => {
	const tools = selectToolsByIntent(ALL, ["¿Quién ganó el mundial de 2010?"]);
	assert.ok(tools.includes("search_web"));
	assert.ok(!tools.includes("pc_open") && !tools.includes("browser") && !tools.includes("create_reminder"));
	// Las de servidores MCP las eligió el usuario: se quedan.
	assert.ok(tools.includes("mcp__notion__search"));
	assert.ok(tools.length < ALL.length / 2);
});

test("Modo ahorro: cada tema trae sus herramientas", () => {
	assert.ok(selectToolsByIntent(ALL, ["Abre Spotify y sube el volumen"]).includes("pc_media"));
	assert.ok(selectToolsByIntent(ALL, ["Recuérdame mañana llamar a mamá"]).includes("create_reminder"));
	assert.ok(selectToolsByIntent(ALL, ["¿Qué clima hace en Santiago?"]).includes("get_weather"));
	assert.ok(selectToolsByIntent(ALL, ["Lee C:\\notas\\lista.txt"]).includes("read_file"));
	assert.ok(selectToolsByIntent(ALL, ["entra a https://example.com e inicia sesión"]).includes("browser"));
});

test("Modo ahorro: «sí, hazlo» mantiene las herramientas de los mensajes anteriores", () => {
	assert.ok(selectToolsByIntent(ALL, ["sí, hazlo", "¿Puedes cerrar la ventana del Bloc de notas?"]).includes("pc_windows"));
});

test("Modo ahorro: nunca deja la lista vacía", () => {
	assert.deepEqual(selectToolsByIntent(["pc_open"], ["hola"]), ["pc_open"]);
	assert.deepEqual(selectToolsByIntent([], ["hola"]), []);
});
