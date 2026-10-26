import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTools } from "./Agent.js";
import { getConfig } from "../../config/config.js";
import { activeModelTuning } from "../llm/providers.js";
import { PC_TOOLS } from "../tools/ToolRegistry.js";

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
