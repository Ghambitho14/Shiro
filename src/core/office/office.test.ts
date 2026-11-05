import { after, test } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carpeta temporal y guardado local: los agentes y la bóveda del usuario no cuentan aquí.
const TMP = mkdtempSync(join(tmpdir(), "shiro-office-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { setConfig } = await import("../../config/config.js");
setConfig({ storage: "local", approvalMode: "ask" });
const { Office, office } = await import("./office.js");
const { runAgent } = await import("../agent/Agent.js");
const { subagentTools } = await import("../tools/modules/delegate.js");
const { executeTool } = await import("../tools/tools.js");
const { isExternalTool } = await import("../tools/untrusted.js");
import type { LLMClient, ToolDef } from "../llm/LLMClient.js";
import type { Message } from "../agent/Types.js";

test("la oficina sigue a cada ayudante: pasos, final y parar", () => {
	const o = new Office();
	const events: string[] = [];
	o.subscribe((e) => events.push(e.type));
	let stopped = false;
	const a = o.open({ name: "Viernes", boss: "Shiro", task: "buscar" }, () => (stopped = true));
	const b = o.open({ name: "Lunes", boss: "Shiro", task: "resumir" }, () => {});
	o.step(a.id, "Buscando en Internet");
	strictEqual(o.list().find((d) => d.id === a.id)?.step, "Buscando en Internet");
	strictEqual(o.stop(a.id), 1);
	ok(stopped);
	o.finish(a.id, "stopped", "El usuario lo detuvo.");
	o.finish(b.id, "done", "x".repeat(5000));
	const done = o.list().find((d) => d.id === b.id)!;
	strictEqual(done.status, "done");
	ok(done.result!.length <= 1500);
	// Un ayudante que ya terminó no cambia más.
	o.step(b.id, "otra cosa");
	strictEqual(o.list().find((d) => d.id === b.id)?.step, "Terminó");
	o.clear();
	strictEqual(o.list().length, 0);
	deepStrictEqual(events.slice(0, 3), ["snapshot", "desk", "desk"]);
});

test("los ayudantes tienen las herramientas del jefe, sin delegate", () => {
	deepStrictEqual(subagentTools(["search_web", "delegate", "fetch_url"]), ["search_web", "fetch_url"]);
	ok(!subagentTools(undefined).includes("delegate"));
	const profile = { tools: ["fetch_url", "exec"] } as Parameters<typeof subagentTools>[1];
	deepStrictEqual(subagentTools(["search_web", "fetch_url"], profile), ["fetch_url"]);
	deepStrictEqual(subagentTools(["search_web"], { tools: "none" } as Parameters<typeof subagentTools>[1]), []);
});

test("delegate fuera de una respuesta de Shiro avisa en vez de fallar", async () => {
	const r = await executeTool("delegate", { tasks: [{ task: "algo" }] });
	strictEqual(r.ok, false);
});

/** Modelo falso: el jefe reparte dos tareas y junta los resultados; cada ayudante responde con su tarea. */
function fakeLLM(seen: { boss?: string[]; helpers: string[][] }): LLMClient {
	const names = (defs: ToolDef[]) => defs.map((d) => d.function.name);
	return {
		chat: async () => "",
		async chatWithTools(messages: Message[], toolsDef, exec) {
			const system = String(messages[0]?.content ?? "");
			const goal = String(messages[messages.length - 1]?.content ?? "");
			if (system.includes("## Eres un ayudante")) {
				seen.helpers.push(names(toolsDef));
				return `hecho: ${goal}`;
			}
			seen.boss = names(toolsDef);
			const r = await exec("delegate", { tasks: [{ name: "Precios", task: "busca precios" }, { task: "busca opiniones" }] });
			return r.ok ? r.content : `falló: ${r.error}`;
		},
		getConfig: () => ({ provider: "fake", baseUrl: "", model: "fake", local: false }),
	};
}

test("el jefe reparte, los ayudantes trabajan y él recibe sus resultados", async () => {
	office.clear();
	const seen: { boss?: string[]; helpers: string[][] } = { helpers: [] };
	const out = await runAgent("compara cosas", {
		llm: fakeLLM(seen),
		agentName: "Shiro",
		allowedTools: ["search_web", "fetch_url", "delegate"],
	});
	ok(seen.boss?.includes("delegate"));
	strictEqual(seen.helpers.length, 2);
	for (const tools of seen.helpers) ok(!tools.includes("delegate"));
	ok(out.includes("### Precios (terminó)"));
	ok(out.includes("hecho: busca precios"));
	ok(out.includes("### Ayudante 2 (terminó)"));
	// Lo de los ayudantes llega marcado como contenido de afuera (lo envuelve client.ts).
	ok(isExternalTool("delegate"));
	const desks = office.list();
	strictEqual(desks.length, 2);
	ok(desks.every((d) => d.status === "done" && d.boss === "Shiro"));
});

test("un ayudante hereda Plan y tampoco puede escribir en el proyecto", async () => {
	office.clear();
	const { createProject } = await import("../projects/projects.js");
	const project = createProject({ name: "Proyecto de Plan" });
	let helperHasPlan = false;
	const llm: LLMClient = {
		chat: async () => "No debería responder sin herramientas.",
		async chatWithTools(messages, _defs, exec) {
			const system = String(messages[0]?.content ?? "");
			if (system.includes("## Eres un ayudante")) {
				helperHasPlan = system.includes("## Planear (solo lectura)");
				const r = await exec("project", { action: "write", path: "Subidos/prohibido.ts", content: "no" });
				return r.ok ? r.content : (r.error ?? "falló");
			}
			const r = await exec("delegate", { tasks: [{ name: "Escritor", task: "Intenta escribir" }] });
			return r.ok ? r.content : `falló: ${r.error}`;
		},
		getConfig: () => ({ provider: "fake", baseUrl: "", model: "fake", local: false }),
	};
	const out = await runAgent("reparte la escritura", {
		llm,
		agentName: "Shiro",
		permissions: "plan",
		allowedTools: ["project", "delegate"],
		mcp: false,
		projectId: project.id,
	});
	ok(helperHasPlan);
	ok(out.includes("Estás planeando: es solo lectura"));
});

test("parar a un ayudante desde la oficina lo detiene y el jefe recibe el aviso", async () => {
	office.clear();
	const llm: LLMClient = {
		chat: async () => "",
		async chatWithTools(messages, _defs, exec, opts) {
			if (String(messages[0]?.content ?? "").includes("## Eres un ayudante")) {
				// Un ayudante lento: espera hasta que lo paren.
				await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return "";
			}
			const pending = exec("delegate", { tasks: [{ name: "Lento", task: "tarda mucho" }] });
			await new Promise((r) => setTimeout(r, 50));
			strictEqual(office.stop(office.list()[0]!.id), 1);
			const r = await pending;
			return r.content;
		},
		getConfig: () => ({ provider: "fake", baseUrl: "", model: "fake", local: false }),
	};
	// Con al menos una herramienta, para que el ayudante no responda en modo solo texto (llm.chat).
	const out = await runAgent("algo largo", { llm, agentName: "Shiro", allowedTools: ["delegate", "calculator"] });
	ok(out.includes("### Lento (se detuvo)"));
	ok(out.includes("El usuario lo detuvo."));
	strictEqual(office.list()[0]?.status, "stopped");
});
