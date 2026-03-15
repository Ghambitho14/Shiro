import { test } from "node:test";
import { strictEqual } from "node:assert";
import { sanitizeModelResponse } from "./sanitizeResponse.js";

test("sanitizeModelResponse quita bloque think al inicio", () => {
	const raw = ` <think>
El usuario dijo hola. Debo responder amablemente.
</think>
Hola, ¿en qué puedo ayudarte?`;
	strictEqual(sanitizeModelResponse(raw), "Hola, ¿en qué puedo ayudarte?");
});

test("sanitizeModelResponse quita think en medio", () => {
	const raw = "Primero. <think>razón interna</think> Después.";
	strictEqual(sanitizeModelResponse(raw).includes("<think>"), false);
	strictEqual(sanitizeModelResponse(raw).includes("Primero"), true);
	strictEqual(sanitizeModelResponse(raw).includes("Después"), true);
});

test("sanitizeModelResponse deja texto sin think igual", () => {
	strictEqual(sanitizeModelResponse("Hola"), "Hola");
	strictEqual(sanitizeModelResponse(""), "");
});
