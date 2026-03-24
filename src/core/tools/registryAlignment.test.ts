import "./tools.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./ToolRegistry.js";
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
