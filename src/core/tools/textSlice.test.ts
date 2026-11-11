import { test } from "node:test";
import assert from "node:assert/strict";
import { findInText, sliceText } from "./textSlice.js";

const LINES = Array.from({ length: 100 }, (_, i) => `línea ${i + 1}`).join("\n");

test("un texto que cabe va entero, sin notas", () => {
	assert.deepEqual(sliceText("uno\ndos\n", { maxChars: 1000 }), { range: "", body: "uno\ndos", note: "" });
});

test("por líneas: corta donde cabe y dice desde qué línea seguir", () => {
	const first = sliceText(LINES, { maxChars: 500 });
	const m = /^ \(líneas 1–(\d+) de 100\)$/.exec(first.range);
	assert.ok(m);
	const end = Number(m[1]);
	assert.ok(first.body.length <= 500 && first.body.endsWith(`línea ${end}`));
	assert.equal(first.note, `\n\n[…continúa: quedan ${100 - end} líneas. Sigue con line=${end + 1}.]`);
	const part = sliceText(LINES, { line: 99, lines: 5, maxChars: 500 });
	assert.deepEqual(part, { range: " (líneas 99–100 de 100)", body: "línea 99\nlínea 100", note: "" });
	assert.equal(sliceText(LINES, { line: 10, lines: 1, maxChars: 500 }).note, "\n\n[…continúa: quedan 90 líneas. Sigue con line=11.]");
	assert.throws(() => sliceText(LINES, { line: 101, maxChars: 500 }), /solo tiene 100 líneas/);
});

test("por letras: para textos sin líneas útiles y líneas que solas no caben", () => {
	const flat = "a".repeat(3000);
	const first = sliceText(flat, { offset: 0, maxChars: 1000 });
	assert.equal(first.range, " (caracteres 0–1000 de 3000)");
	assert.match(first.note, /Sigue con offset=1000\.\]$/);
	assert.equal(sliceText(flat, { offset: 2500, maxChars: 1000 }).note, "");
	assert.throws(() => sliceText(flat, { offset: 3000, maxChars: 1000 }), /solo tiene 3000 caracteres/);
	// Una línea enorme en medio de un archivo con líneas.
	const mixed = `corta\n${"b".repeat(3000)}\nfinal`;
	const long = sliceText(mixed, { line: 2, maxChars: 1000 });
	assert.equal(long.body, "b".repeat(1000));
	assert.match(long.note, /La línea 2 es muy larga \(3000 caracteres\).*offset=1006\.\]$/);
});

test("findInText: las líneas con todas las palabras, con su contexto y sin repetir", () => {
	const text = ["Cabecera", "El precio es 10", "y el envío cuesta 5", "", "Otra cosa", "Precio del envío: 15"].join("\n");
	const r = findInText(text, "precio", { context: 1, maxChars: 1000 });
	assert.equal(r.hits, 2);
	assert.equal(r.body, "Cabecera\nEl precio es 10\ny el envío cuesta 5\n…\nOtra cosa\nPrecio del envío: 15");
	assert.equal(findInText(text, "envio precio", { context: 0, maxChars: 1000 }).body, "Precio del envío: 15");
	assert.deepEqual(findInText(text, "nada", { maxChars: 1000 }), { body: "", hits: 0, shown: 0 });
});
