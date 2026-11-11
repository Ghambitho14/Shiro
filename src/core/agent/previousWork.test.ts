import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviousWork } from "./previousWork.js";

test("cuenta qué herramientas usó en la respuesta anterior, y cuáles fallaron", () => {
	const block = buildPreviousWork([
		{ role: "user" },
		{ role: "assistant", tools: [{ name: "search_web", label: "Buscando en internet: algo viejo", ok: true }] },
		{ role: "user" },
		{
			role: "assistant",
			tools: [
				{ name: "project", label: "Buscando en el proyecto: saverOn", ok: true },
				{ name: "todo", label: "Actualizando la lista de tareas", ok: true },
				{ name: "terminal", label: "Ejecutando en la terminal: npm test", ok: false },
			],
		},
		{ role: "user" },
	]);
	assert.ok(block?.startsWith("## Lo que hiciste en tu respuesta anterior\nUsaste estas herramientas."));
	assert.match(block!, /Sus resultados ya no están aquí/);
	assert.match(block!, /- ✓ Buscando en el proyecto: saverOn\n- ✗ Ejecutando en la terminal: npm test \(falló\)$/);
	// Solo la última respuesta, y las llamadas a la lista de tareas no son pasos.
	assert.doesNotMatch(block!, /algo viejo|Actualizando la lista/);
});

test("incluye la lista de tareas que llevaba", () => {
	const block = buildPreviousWork([
		{
			role: "assistant",
			tools: [{ name: "project", label: "Leyendo a.ts" }],
			todo: [
				{ text: "Leer el código", status: "done" },
				{ text: "Arreglar el fallo", status: "in_progress" },
				{ text: "Probar", status: "pending" },
			],
		},
		{ role: "user" },
	]);
	assert.match(block!, /Lista de tareas que llevabas.*\n- \[x\] Leer el código\n- \[~\] Arreglar el fallo\n- \[ \] Probar$/);
	// Solo con lista, sin pasos.
	assert.match(buildPreviousWork([{ role: "assistant", todo: [{ text: "Una", status: "pending" }] }])!, /^## Lo que hiciste en tu respuesta anterior\nLista de tareas/);
});

test("sin herramientas no hay bloque; si son muchas, quedan las últimas y cabe en el límite", () => {
	assert.equal(buildPreviousWork(undefined), undefined);
	assert.equal(buildPreviousWork([{ role: "user" }]), undefined);
	assert.equal(buildPreviousWork([{ role: "assistant" }, { role: "user" }]), undefined);
	assert.equal(buildPreviousWork([{ role: "assistant", tools: [{ name: "todo", label: "x" }] }]), undefined);
	const many = Array.from({ length: 40 }, (_, i) => ({ name: "project", label: `Leyendo el archivo número ${i + 1} de una carpeta con un nombre bastante largo` }));
	const block = buildPreviousWork([{ role: "assistant", tools: many }])!;
	assert.ok(block.length <= 900, String(block.length));
	assert.match(block, /\(y \d+ pasos antes\)/);
	assert.match(block, /número 40 /);
	assert.doesNotMatch(block, /número 1 /);
});
