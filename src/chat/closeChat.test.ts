import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-closechat-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { compactConversation, createChatSession, getChatSession, sanitizeMessages } = await import("./ChatStore.js");
const { closeChatSession, CloseChatError, summaryPrompt, transcriptOf } = await import("./closeChat.js");
const { listMemories } = await import("../core/memory/memories.js");
type LLMClient = import("../core/llm/LLMClient.js").LLMClient;
type Message = import("../core/agent/Types.js").Message;

function fakeLLM(reply: string, seen: Message[][] = []): LLMClient {
	return {
		chat: async (messages) => {
			seen.push(messages);
			return reply;
		},
		chatWithTools: async () => "",
		getConfig: () => ({ provider: "test", baseUrl: "", model: "test", local: true }),
	};
}

test("compactConversation: sin resumen deja todo; con resumen, el último y lo de después", () => {
	const plain = [
		{ role: "user" as const, content: "hola" },
		{ role: "assistant" as const, content: "hola" },
	];
	assert.deepEqual(compactConversation(plain), { messages: plain });
	const msgs = [
		{ role: "user" as const, content: "uno" },
		{ role: "assistant" as const, content: "resumen viejo", summary: true as const },
		{ role: "user" as const, content: "dos" },
		{ role: "assistant" as const, content: "resumen nuevo", summary: true as const },
		{ role: "user" as const, content: "tres" },
	];
	const out = compactConversation(msgs);
	assert.equal(out.summary, "resumen nuevo");
	assert.deepEqual(out.messages, [msgs[4]]);
});

test("sanitizeMessages: summary solo en respuestas del asistente y solo si es true", () => {
	const out = sanitizeMessages([
		{ role: "user", content: "a", summary: true },
		{ role: "assistant", content: "b", summary: "sí" },
		{ role: "assistant", content: "c", summary: true },
	]);
	assert.equal(out[0].summary, undefined);
	assert.equal(out[1].summary, undefined);
	assert.equal(out[2].summary, true);
});

test("transcriptOf: nombra a quién habla y recorta por el principio si no cabe", () => {
	const t = transcriptOf(
		[
			{ role: "user", content: "¿qué hora es?" },
			{ role: "assistant", content: "Las tres.", agent: "viernes", agentName: "Viernes" },
			{ role: "assistant", content: "Y yo digo hola." },
		],
		"Aku",
	);
	assert.match(t, /^Usuario: ¿qué hora es\?/);
	assert.match(t, /Viernes: Las tres\./);
	assert.match(t, /Aku: Y yo digo hola\./);
	const long = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `${i} ${"x".repeat(2900)}` }));
	const cut = transcriptOf(long, "Aku");
	assert.match(cut, /^\(…los primeros mensajes no caben\)/);
	assert.match(cut, /Usuario: 29 /);
	assert.ok(cut.length < 45_000);
});

test("summaryPrompt: junta el resumen anterior y pide no copiar secretos", () => {
	const [system, user] = summaryPrompt("Usuario: hola", "- antes", "Aku");
	assert.match(String(system.content), /Nunca copies contraseñas/);
	assert.match(String(user.content), /- antes/);
	assert.match(String(user.content), /Usuario: hola/);
});

test("closeChatSession: resume, guarda el recuerdo y añade el mensaje summary; después solo lo nuevo", async () => {
	const session = await createChatSession([
		{ role: "user", content: "Me llamo Jhon y uso LM Studio" },
		{ role: "assistant", content: "Anotado." },
	]);
	const seen: Message[][] = [];
	const closed = await closeChatSession(session.id, fakeLLM("<think>pensando</think>- Jhon usa LM Studio.", seen));
	assert.ok(closed);
	const last = closed.messages.at(-1)!;
	assert.equal(last.summary, true);
	assert.equal(last.content, "- Jhon usa LM Studio.");
	assert.match(String(seen[0][1].content), /Usuario: Me llamo Jhon/);
	assert.equal((await getChatSession(session.id))?.messages.length, 3);
	const memories = await listMemories();
	assert.ok(memories.some((m) => m.content.includes("- Jhon usa LM Studio.") && m.tags?.includes("resumen")));

	// Sin nada nuevo no hay qué resumir.
	await assert.rejects(closeChatSession(session.id, fakeLLM("x")), CloseChatError);
	// Un modelo que no devuelve nada no deja un resumen vacío.
	const other = await createChatSession([
		{ role: "user", content: "hola" },
		{ role: "assistant", content: "hola" },
	]);
	await assert.rejects(closeChatSession(other.id, fakeLLM("<think>solo pensé</think>")), CloseChatError);
	assert.equal(await closeChatSession("no-existe", fakeLLM("x")), null);
});
