import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { EXAM_TASKS, runExamTask, listExamTasks } = await import("./agentExam.js");
const { getProject, listProjects, uploadsDir } = await import("../projects/projects.js");
type Opts = import("./Agent.js").AgentOptions;

const task = (id: string) => EXAM_TASKS.find((t) => t.id === id)!;

test("examen: las tareas tienen id único y se listan sin su comprobación", () => {
	const ids = EXAM_TASKS.map((t) => t.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(listExamTasks().every((t) => !("check" in t)));
});

test("examen: con un modelo falso, aprueba lo correcto y explica lo que falla; el proyecto temporal se borra", async () => {
	const good = await runExamTask(task("calculadora"), async () => "Son 189.077.507.");
	assert.equal(good.ok, true, good.reason);
	const bad = await runExamTask(task("calculadora"), async () => "Unos 190 millones.");
	assert.equal(bad.ok, false);
	assert.match(bad.reason!, /189\.077\.507/);

	// Editar: el modelo falso cambia el archivo del proyecto temporal como lo haría project edit.
	const before = listProjects().length;
	const edited = await runExamTask(task("editar-archivo"), async (_goal, opts: Opts) => {
		const p = getProject(opts.projectId!)!;
		const file = join(uploadsDir(p.id), "config.json");
		writeFileSync(file, readFileSync(file, "utf-8").replace("3000", "4000"));
		opts.onToolEvent?.({ phase: "start", id: "t1", name: "project", label: "Editar config.json" });
		return "Listo, el puerto ahora es 4000.";
	});
	assert.equal(edited.ok, true, edited.reason);
	assert.deepEqual(edited.tools, ["project"]);
	assert.equal(listProjects().length, before, "el proyecto temporal se borró");

	// Solo deja escribir en el proyecto: lo demás se rechaza.
	const scope = await runExamTask(task("alcance-hacking"), async (_g, opts: Opts) => {
		assert.equal(await opts.approver!({ tool: "exec", summary: "nmap" }), false);
		assert.equal(await opts.approver!({ tool: "project", summary: "editar" }), true);
		return "Primero necesito el alcance autorizado.";
	});
	assert.equal(scope.ok, true, scope.reason);

	const injected = await runExamTask(task("inyeccion"), async () => "PIÑA");
	assert.equal(injected.ok, false);
});
