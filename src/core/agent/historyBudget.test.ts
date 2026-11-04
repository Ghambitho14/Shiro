import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "./Types.js";
import { CLOUD_HISTORY_TOKENS, historyBudget, messageTokens, trimHistory } from "./historyBudget.js";

const msg = (role: "user" | "assistant", chars: number): Message => ({ role, content: "x".repeat(chars) });

test("trimHistory deja los últimos mensajes que caben y empieza por el usuario", () => {
	const chat = [msg("user", 700), msg("assistant", 700), msg("user", 700), msg("assistant", 700), msg("user", 70)];
	const each = messageTokens(chat[0]);
	// Caben el último y dos más.
	assert.deepEqual(trimHistory(chat, messageTokens(chat[4]) + each * 2), chat.slice(2));
	// Caben el último y uno más, pero ese es del asistente: se quita para empezar por el usuario.
	assert.deepEqual(trimHistory(chat, messageTokens(chat[4]) + each), [chat[4]]);
});

test("trimHistory no quita nada si todo cabe, y nunca quita el último mensaje", () => {
	const chat = [msg("user", 10), msg("assistant", 10), msg("user", 10)];
	assert.equal(trimHistory(chat, 10_000), chat);
	const huge = [msg("user", 10), msg("assistant", 10), msg("user", 100_000)];
	assert.deepEqual(trimHistory(huge, 100), [huge[2]]);
});

test("Las imágenes cuentan en el presupuesto", () => {
	const withImage: Message = { role: "user", content: [{ type: "text", text: "mira" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
	assert.ok(messageTokens(withImage) > 500);
});

test("historyBudget: el elegido manda; en automático, la nube tiene tope y lo local usa lo que queda", () => {
	assert.equal(historyBudget({ setting: 4000, local: true, contextWindow: 8192, fixedChars: 0 }), 4000);
	assert.equal(historyBudget({ setting: 0, local: false, contextWindow: 8192, fixedChars: 0 }), CLOUD_HISTORY_TOKENS);
	// 8192 de contexto, ≈4000 de instrucciones y herramientas, 1024 para la respuesta.
	const local = historyBudget({ setting: 0, local: true, contextWindow: 8192, fixedChars: 14_000 });
	assert.equal(local, 8192 - 4000 - 1024);
	// Si no queda casi nada, se deja un mínimo.
	assert.equal(historyBudget({ setting: 0, local: true, contextWindow: 4096, fixedChars: 40_000 }), 1500);
});
