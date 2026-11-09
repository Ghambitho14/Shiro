import "./tools.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getToolsDefinition, TOOLS } from "./ToolRegistry.js";
import { toolSchemas } from "./schemas.js";
import { hasToolExecutor } from "./toolExecutors.js";

test("cada tool del registro tiene schema Zod o ejecutor registrado", () => {
	for (const t of TOOLS) {
		const name = t.name;
		const hasSchema = Boolean(toolSchemas[name]);
		const hasExec = hasToolExecutor(name);
		assert.ok(
			hasSchema || hasExec,
			`${name}: añade toolSchemas["${name}"] o registerToolExecutor("${name}", ...)`,
		);
	}
});

test("los ejemplos le llegan al modelo sin pasar del tope de la descripción", () => {
	const defs = new Map(getToolsDefinition().map((d) => [d.function.name, d.function.description ?? ""]));
	assert.ok(defs.get("pc_media")?.includes('"siguiente canción" → pc_media'));
	assert.ok(defs.get("terminal")?.includes("Ejemplos:"));
	for (const t of TOOLS) {
		const description = defs.get(t.name) ?? "";
		assert.ok(description.startsWith(t.description), `${t.name}: la descripción no se recorta`);
		assert.ok(description.length <= 1024, `${t.name}: ${description.length} letras`);
	}
});
