import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffHunks, diffLines } from "./diff.js";
import { beginUndo, commitUndo, describeChanges, undoChanges } from "./undoStore.js";
import { chunkText } from "./semanticIndex.js";
import { pickEmbeddingModel } from "../memory/EmbeddingsClient.js";

test("diferencias línea a línea", () => {
	const ops = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
	assert.deepEqual(
		ops.map((l) => `${l.kind[0]}${l.text}`),
		["sa", "db", "aB", "sc", "ad"],
	);
	assert.deepEqual(diffLines("", "x\n").map((l) => l.kind), ["add"]);
	assert.deepEqual(diffLines("x\r\ny\r\n", "x\ny\n").map((l) => l.kind), ["same", "same"]);

	const before = Array.from({ length: 40 }, (_, i) => `línea ${i + 1}`).join("\n");
	const after = before.replace("línea 5", "LÍNEA 5").replace("línea 35", "LÍNEA 35");
	const d = diffHunks(before, after);
	assert.equal(d.adds, 2);
	assert.equal(d.dels, 2);
	assert.equal(d.hunks.length, 2, "dos cambios lejanos son dos tramos");
	assert.equal(d.hunks[0].oldStart, 2);
	assert.equal(diffHunks(before, after, 20).hunks.length, 1, "con mucho contexto se juntan");
	const cut = diffHunks("", Array.from({ length: 50 }, (_, i) => String(i)).join("\n"), 3, 10);
	assert.equal(cut.truncated, true);
	assert.equal(cut.adds, 50);
});

test("cambios de una respuesta: describir y deshacer todo", () => {
	const dir = mkdtempSync(join(tmpdir(), "aku-cambios-"));
	try {
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		writeFileSync(a, "uno\ndos\n");
		// Dos cambios seguidos en a.txt y uno que crea b.txt.
		const p1 = beginUndo(a, "P/a.txt");
		writeFileSync(a, "uno\nDOS\n");
		const id1 = commitUndo(p1)!;
		const p2 = beginUndo(a, "P/a.txt");
		writeFileSync(a, "uno\nDOS\ntres\n");
		const id2 = commitUndo(p2)!;
		const p3 = beginUndo(b, "P/b.txt");
		writeFileSync(b, "nuevo\n");
		const id3 = commitUndo(p3)!;

		const changes = describeChanges([id1, id2, id3]);
		assert.deepEqual(
			changes.map((c) => [c.path, c.created, c.adds, c.dels, c.ids.length, c.changedAfter]),
			[
				["P/a.txt", false, 2, 1, 2, false],
				["P/b.txt", true, 1, 0, 1, false],
			],
		);

		// Alguien cambia b.txt después: no se pisa sin force.
		writeFileSync(b, "tocado a mano\n");
		const r = undoChanges([id1, id2, id3, "00000000-0000-0000-0000-000000000000"]);
		assert.deepEqual(r.undone.map((u) => u.path), ["P/a.txt"]);
		assert.deepEqual(r.changed, ["P/b.txt"]);
		assert.deepEqual(r.gone, ["00000000-0000-0000-0000-000000000000"]);
		assert.equal(readFileSync(a, "utf-8"), "uno\ndos\n", "vuelve a como estaba antes del primer cambio");
		assert.equal(describeChanges([id1, id2]).length, 0, "las copias deshechas ya no están");

		const forced = undoChanges([id3], true);
		assert.deepEqual(forced.undone, [{ path: "P/b.txt", deleted: true, ids: [id3] }]);
		assert.equal(existsSync(b), false, "no existía antes: se borra");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("trozos para la búsqueda por significado", () => {
	const text = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join("\n");
	const chunks = chunkText(text);
	assert.deepEqual(chunks.map((c) => [c.start, c.end]), [
		[1, 40],
		[33, 72],
		[65, 100],
	]);
	assert.deepEqual(chunkText("\n\n\n"), []);
	const long = chunkText(Array.from({ length: 10 }, () => "x".repeat(500)).join("\n"));
	assert.ok(long.every((c) => c.text.length <= 2000));
});

test("elige el modelo de embeddings del servidor", () => {
	const ids = ["qwen/qwen3.5-9b", "text-embedding-nomic-embed-text-v1.5", "otro-embed"];
	assert.equal(pickEmbeddingModel(ids, "nomic-embed-text"), "text-embedding-nomic-embed-text-v1.5");
	assert.equal(pickEmbeddingModel(["qwen", "bge-embed-m3"], "nomic-embed-text"), "bge-embed-m3");
	assert.equal(pickEmbeddingModel(["qwen", "llama"], "nomic-embed-text"), null);
});
