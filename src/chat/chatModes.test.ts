import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-chatmodes-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { createChatSession, deleteChatSession, getChatSession, listChatSessions, saveChatSession } = await import("./ChatStore.js");
const { modeOfMessages, removeChatMode, resetChatModesCache } = await import("./chatModes.js");

const modeIn = async (id: string) => (await listChatSessions()).find((s) => s.id === id)?.mode;

test("modeOfMessages: el del último mensaje del usuario que tenga modo", () => {
	assert.equal(modeOfMessages([]), undefined);
	assert.equal(modeOfMessages([{ role: "user" }, { role: "assistant", mode: "code" }]), undefined);
	assert.equal(modeOfMessages([{ role: "user", mode: "hacking" }, { role: "user", mode: "code" }, { role: "user" }]), "code");
	assert.equal(modeOfMessages([{ role: "user", mode: "inventado" }]), undefined);
});

test("un chat nuevo se queda en el modo en que se creó, aunque aún no tenga mensajes", async () => {
	const s = await createChatSession([], "code");
	assert.equal(s.mode, "code");
	assert.equal(await modeIn(s.id), "code");
	assert.equal((await getChatSession(s.id))?.mode, "code");
	// Sobrevive a volver a leer el archivo (otro arranque).
	resetChatModesCache();
	assert.equal(await modeIn(s.id), "code");
	assert.equal(JSON.parse(readFileSync(join(TMP, "data", "chat-modes.json"), "utf-8"))[s.id], "code");
});

test("un chat sin modo anotado lo toma de sus mensajes; sin mensajes del usuario es de Chat", async () => {
	const empty = await createChatSession();
	assert.equal(await modeIn(empty.id), "chat");
	await saveChatSession(empty.id, [{ role: "user", content: "escanea mi VPS", mode: "hacking" }]);
	assert.equal(await modeIn(empty.id), "hacking");

	// Chat de antes (o de WhatsApp): se clasifica una vez por sus mensajes al listar.
	const old = await createChatSession([{ role: "user", content: "arregla esto", mode: "code" }]);
	removeChatMode(old.id);
	assert.equal(await modeIn(old.id), "code");
	const plain = await createChatSession([{ role: "user", content: "hola" }]);
	removeChatMode(plain.id);
	assert.equal(await modeIn(plain.id), "chat");
});

test("al borrar un chat se olvida su modo", async () => {
	const s = await createChatSession([], "hacking");
	assert.equal(await deleteChatSession(s.id), true);
	resetChatModesCache();
	const file = join(TMP, "data", "chat-modes.json");
	assert.ok(existsSync(file));
	assert.equal(s.id in JSON.parse(readFileSync(file, "utf-8")), false);
});
