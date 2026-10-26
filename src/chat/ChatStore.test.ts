import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-chatstore-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { sanitizeMessages } = await import("./ChatStore.js");

test("sanitizeMessages: agent y agentName solo en respuestas del asistente con un id válido", () => {
	const out = sanitizeMessages([
		{ role: "user", content: "hola", agent: "viernes", agentName: "Viernes" },
		{ role: "assistant", content: "Hola, soy Viernes.", agent: "viernes", agentName: "  Viernes  " },
		{ role: "assistant", content: "id con mayúsculas", agent: "Viernes", agentName: "Viernes" },
		{ role: "assistant", content: "id con ruta", agent: "../config", agentName: "X" },
		{ role: "assistant", content: "id que no es texto", agent: 7, agentName: "X" },
		{ role: "assistant", content: "nombre largo", agent: "lunes", agentName: "L".repeat(60) },
		{ role: "assistant", content: "sin nombre", agent: "lunes", agentName: "   " },
		{ role: "assistant", content: "nombre sin id", agentName: "Lunes" },
	]);
	assert.deepEqual(out, [
		{ role: "user", content: "hola" },
		{ role: "assistant", content: "Hola, soy Viernes.", agent: "viernes", agentName: "Viernes" },
		{ role: "assistant", content: "id con mayúsculas" },
		{ role: "assistant", content: "id con ruta" },
		{ role: "assistant", content: "id que no es texto" },
		{ role: "assistant", content: "nombre largo", agent: "lunes", agentName: "L".repeat(40) },
		{ role: "assistant", content: "sin nombre", agent: "lunes" },
		{ role: "assistant", content: "nombre sin id" },
	]);
});
