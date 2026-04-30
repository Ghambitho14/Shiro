import { test } from "node:test";
import { strictEqual } from "node:assert";
import {
	sanitizeModelResponse,
	isMeaningfulResponse,
	FALLBACK_EMPTY_RESPONSE,
	isPotentiallyDangerousCommand,
} from "./sanitizeResponse.js";

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

test("isMeaningfulResponse rechaza vacío y genéricos", () => {
	strictEqual(isMeaningfulResponse(""), false);
	strictEqual(isMeaningfulResponse("  "), false);
	strictEqual(isMeaningfulResponse("Listo."), false);
	strictEqual(isMeaningfulResponse("listo"), false);
	strictEqual(isMeaningfulResponse("OK"), false);
	strictEqual(isMeaningfulResponse("(Sin respuesta de texto)"), false);
});

test("isMeaningfulResponse acepta respuestas útiles", () => {
	strictEqual(isMeaningfulResponse("El archivo contiene 3 líneas."), true);
	strictEqual(isMeaningfulResponse("Listo. He guardado el archivo en X."), true);
	strictEqual(isMeaningfulResponse("No encontré el archivo."), true);
});

test("FALLBACK_EMPTY_RESPONSE está definido", () => {
	strictEqual(typeof FALLBACK_EMPTY_RESPONSE, "string");
	strictEqual(FALLBACK_EMPTY_RESPONSE.length > 0, true);
});

test("isPotentiallyDangerousCommand detecta comandos peligrosos", () => {
	strictEqual(isPotentiallyDangerousCommand("rm -rf /"), true);
	strictEqual(isPotentiallyDangerousCommand("echo hola && del /Q C:\\temp"), true);
	strictEqual(isPotentiallyDangerousCommand("powershell -encodedCommand AAAA"), true);
});

test("isPotentiallyDangerousCommand permite comandos simples", () => {
	strictEqual(isPotentiallyDangerousCommand("npm run test"), false);
	strictEqual(isPotentiallyDangerousCommand("git status"), false);
});
