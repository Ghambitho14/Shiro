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
	assert.match(block!, /- ✓ Buscando en el proyecto: saverOn\n- ✗ Ejecutando en la terminal: npm test \(falló\)\nEn las respuestas de antes .*\n- ✓ Buscando en internet: algo viejo$/);
	// Las llamadas a la lista de tareas no son pasos.
	assert.doesNotMatch(block!, /Actualizando la lista/);
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
	assert.ok(block.length <= 1300, String(block.length));
	assert.match(block, /\(y \d+ pasos antes\)/);
	assert.match(block, /número 40 /);
	assert.doesNotMatch(block, /número 1 /);
});

test("recuerda también lo que hizo en las dos respuestas de antes, si cabe", async () => {
	const { buildPreviousWork } = await import("./previousWork.js");
	const step = (label: string, ok = true) => ({ name: "project", label, ok });
	const conversation = [
		{ role: "assistant", tools: [step("muy vieja")] },
		{ role: "user" },
		{ role: "assistant", tools: [step("leer a.ts"), step("buscar límite", false)] },
		{ role: "user" },
		{ role: "assistant" },
		{ role: "user" },
		{ role: "assistant", tools: [step("leer b.ts")] },
		{ role: "user" },
		{ role: "assistant", tools: [step("editar c.ts")] },
	];
	const note = buildPreviousWork(conversation) ?? "";
	if (!note.includes("- ✓ editar c.ts")) throw new Error(note);
	if (!note.includes("En las respuestas de antes (de la más reciente a la más vieja):\n- ✓ leer b.ts\n- ✓ leer a.ts; ✗ buscar límite")) throw new Error(note);
	if (note.includes("muy vieja")) throw new Error("solo las dos de antes");
	// Sin sitio, lo de antes se deja fuera entero.
	const short = buildPreviousWork(conversation, 260) ?? "";
	if (short.includes("respuestas de antes") || !short.includes("editar c.ts")) throw new Error(short);
});
