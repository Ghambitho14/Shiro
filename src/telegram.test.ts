import { test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { looksLikeBotToken, splitForTelegram } from "./telegram.js";

test("splitForTelegram no parte los mensajes cortos", () => {
	deepStrictEqual(splitForTelegram("  Hola  "), ["Hola"]);
	deepStrictEqual(splitForTelegram(""), []);
});

test("splitForTelegram corta por saltos de línea sin pasarse del límite", () => {
	const text = Array.from({ length: 30 }, (_, i) => `Línea ${i} ${"x".repeat(20)}`).join("\n");
	const parts = splitForTelegram(text, 100);
	ok(parts.length > 1);
	ok(parts.every((p) => p.length <= 100), parts.map((p) => p.length).join(","));
	ok(parts.every((p) => p.startsWith("Línea")), "cada trozo empieza en una línea entera");
	strictEqual(parts.join("\n"), text);
});

test("splitForTelegram corta un texto sin espacios en trozos exactos", () => {
	const parts = splitForTelegram("a".repeat(250), 100);
	deepStrictEqual(parts.map((p) => p.length), [100, 100, 50]);
});

test("looksLikeBotToken reconoce el formato de @BotFather", () => {
	ok(looksLikeBotToken("123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
	ok(!looksLikeBotToken("hola"));
	ok(!looksLikeBotToken("123456789"));
	ok(!looksLikeBotToken("abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
});
