import { after, test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "shiro-undo-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { beginUndo, commitUndo, undoChange } = await import("./undoStore.js");
const { createProject, addFolder, runWithProject } = await import("./projects.js");
const { executeProject } = await import("../tools/modules/project.js");
const { runWithAgentContext } = await import("../agent/runContext.js");

const folder = join(TMP, "app");
mkdirSync(folder, { recursive: true });

test("deshacer devuelve el archivo a como estaba, byte a byte", () => {
	const file = join(folder, "a.txt");
	writeFileSync(file, "uno\r\ndos\r\n");
	const pending = beginUndo(file, "app/a.txt");
	writeFileSync(file, "uno\r\nDOS\r\n");
	const id = commitUndo(pending)!;
	deepStrictEqual(undoChange(id), { ok: true, path: "app/a.txt", deleted: false });
	strictEqual(readFileSync(file, "utf-8"), "uno\r\ndos\r\n");
	// La copia se usa una sola vez.
	deepStrictEqual(undoChange(id), { ok: false, reason: "gone" });
});

test("deshacer un archivo nuevo lo borra", () => {
	const file = join(folder, "nuevo.txt");
	const pending = beginUndo(file, "app/nuevo.txt");
	writeFileSync(file, "hola");
	deepStrictEqual(undoChange(commitUndo(pending)!), { ok: true, path: "app/nuevo.txt", deleted: true });
	strictEqual(existsSync(file), false);
});

test("si el archivo cambió después no se pisa, salvo que se fuerce", () => {
	const file = join(folder, "b.txt");
	writeFileSync(file, "v1");
	const pending = beginUndo(file, "app/b.txt");
	writeFileSync(file, "v2");
	const id = commitUndo(pending)!;
	writeFileSync(file, "v3 del usuario");
	deepStrictEqual(undoChange(id), { ok: false, reason: "changed", path: "app/b.txt" });
	strictEqual(readFileSync(file, "utf-8"), "v3 del usuario");
	strictEqual(undoChange(id, true).ok, true);
	strictEqual(readFileSync(file, "utf-8"), "v1");
});

test("un id raro no toca nada", () => {
	deepStrictEqual(undoChange("../../config"), { ok: false, reason: "gone" });
	deepStrictEqual(undoChange(""), { ok: false, reason: "gone" });
});

test("project edit y write dejan el id para deshacer en la respuesta en curso", async () => {
	const project = addFolder(createProject({ name: "app" }).id, folder)!;
	const file = join(folder, "c.txt");
	writeFileSync(file, "alfa\nbeta\n");
	const run = { subagent: false, launched: 0 } as Parameters<typeof runWithAgentContext>[0];
	await runWithAgentContext(run, () =>
		runWithProject(project, async () => {
			const r = await executeProject({ action: "edit", path: "app/c.txt", old_text: "beta", new_text: "gamma" });
			strictEqual(r.ok, true);
			strictEqual(typeof run.undo, "string");
			strictEqual(undoChange(run.undo!).ok, true);
			strictEqual(readFileSync(file, "utf-8"), "alfa\nbeta\n");
			// Un cambio que falla no deja copia.
			run.undo = undefined;
			strictEqual((await executeProject({ action: "edit", path: "app/c.txt", old_text: "no está", new_text: "x" })).ok, false);
			strictEqual(run.undo, undefined);
		}),
	);
});
