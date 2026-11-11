import { test } from "node:test";
import { strictEqual } from "node:assert";
import { createSelfCheck } from "./selfCheck.js";

const edit = { action: "edit", path: "app/src/a.ts" };

test("cambió código y no ejecutó nada: avisa una sola vez, con los archivos y los comandos", () => {
	const check = createSelfCheck(["npm run check", "npm test"]);
	strictEqual(check.pending(), undefined);
	check.note("project", { action: "read", path: "app/src/a.ts" }, true);
	strictEqual(check.pending(), undefined);
	check.note("project", edit, true);
	const note = check.pending() ?? "";
	strictEqual(note.includes("app/src/a.ts") && note.includes("npm run check, npm test"), true);
	strictEqual(check.pending(), undefined);
});

test("no avisa si ya corrió un comando después, si el cambio falló o si solo tocó documentación", () => {
	const check = createSelfCheck(["npm test"]);
	check.note("project", edit, true);
	check.note("terminal", { action: "run", command: "npm test" }, false);
	strictEqual(check.pending(), undefined);
	check.note("project", edit, false);
	check.note("project", { action: "write", path: "app/README.md" }, true);
	strictEqual(check.pending(), undefined);
	// Leer la terminal no es ejecutar: sigue pendiente.
	check.note("project", edit, true);
	check.note("terminal", { action: "read" }, true);
	strictEqual(typeof check.pending(), "string");
});

test("sin comandos de comprobación conocidos no dice nada", () => {
	const check = createSelfCheck([]);
	check.note("project", edit, true);
	strictEqual(check.pending(), undefined);
});
