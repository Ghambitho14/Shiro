import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { startRun, finishRun, createReplyRecorder, recoverInterruptedRuns, interruptedReply } = await import("./backgroundRuns.js");
const { createChatSession, getChatSession, sanitizeMessages } = await import("./ChatStore.js");
const { DATA_DIR } = await import("../config/config.js");
const activeFile = join(DATA_DIR, "cache", "active-runs.json");

test("retomar: lo que va haciendo se apunta en disco y se borra al terminar", async () => {
	const chat = await createChatSession([{ role: "user", content: "arregla el login" }]);
	const run = startRun(chat.id);
	const rec = createReplyRecorder(run.id);
	rec.tool({ phase: "start", id: "t1", name: "project", label: "Leer login.ts" });
	rec.tool({ phase: "end", id: "t1", name: "project", ok: true });
	rec.todo([
		{ text: "Leer login.ts", status: "done" },
		{ text: "Arreglar", status: "in_progress" },
	]);
	rec.text("Voy a revisar ");
	await new Promise((r) => setTimeout(r, 1200));
	const saved = JSON.parse(readFileSync(activeFile, "utf-8"));
	assert.equal(saved[0].sessionId, chat.id);
	assert.equal(saved[0].tools[0].label, "Leer login.ts");
	assert.equal(saved[0].text, "Voy a revisar ");
	finishRun(run.id);
	assert.equal(existsSync(activeFile), false);
});

test("retomar: al arrancar, lo que quedó a medias va al chat con la marca interrupted", async () => {
	const chat = await createChatSession([{ role: "user", content: "haz la migración" }]);
	const empty = await createChatSession([{ role: "user", content: "otra" }]);
	mkdirSync(join(DATA_DIR, "cache"), { recursive: true });
	writeFileSync(
		activeFile,
		JSON.stringify([
			{
				sessionId: chat.id,
				startedAt: 1,
				tools: [{ name: "terminal", label: "npm test", ok: true }],
				todo: [
					{ content: "A", status: "done" },
					{ content: "B", status: "pending" },
				],
				text: "",
			},
			{ sessionId: empty.id, startedAt: 1, tools: [], text: "" },
		]),
	);
	assert.equal(await recoverInterruptedRuns(), 1);
	assert.equal(existsSync(activeFile), false);
	const last = (await getChatSession(chat.id))!.messages.at(-1)!;
	assert.equal(last.interrupted, true);
	assert.match(String(last.content), /Iba en 1 de 2 tareas/);
	assert.equal(last.tools?.[0].label, "npm test");
	assert.equal((await getChatSession(empty.id))!.messages.length, 1, "sin pasos ni texto no se añade nada");
	// La marca sobrevive al guardado de la web.
	assert.equal(sanitizeMessages([{ role: "assistant", content: "x", interrupted: true }])[0].interrupted, true);
	assert.match(String(interruptedReply({ sessionId: "s", startedAt: 0, tools: [], text: "a medias" }).content), /^a medias/);
});
