import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-gate-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
for (const k of ["SHIRO_LLM_PROVIDER", "SHIRO_LLM_MODEL", "SHIRO_LLM_BASE_URL", "SHIRO_LLM_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[k];
after(() => rmSync(TMP, { recursive: true, force: true }));

const gate = await import("./modelGate.js");
const { setConfig } = await import("../../config/config.js");
const { resolveLLMSettings, activeModelTuning, modelSupportsVision } = await import("./providers.js");
const { setModelTuning } = await import("./modelSettings.js");

const unloaded: string[] = [];
beforeEach(() => {
	gate.resetModelGateForTests();
	unloaded.length = 0;
	gate.setUnloadersForTests({
		ollama: async (server, keep) => {
			unloaded.push(`${server.model}>${keep.model}`);
			return [server.model];
		},
	});
});

const target = (model: string, provider = "ollama") => gate.gateTarget({ provider: provider as "ollama", model, baseUrl: "http://localhost:11434" });
const tick = () => new Promise((r) => setTimeout(r, 5));

test("el mismo modelo no espera; uno distinto espera y descarga el anterior una vez", async () => {
	const a1 = await gate.acquireModel(target("a"));
	assert.deepEqual(unloaded, ["a>a"], "la primera vez se descarga lo demás que haya en el servidor");
	const a2 = await gate.acquireModel(target("a"));
	let gotB = false;
	const b = gate.acquireModel(target("b")).then((release) => {
		gotB = true;
		return release;
	});
	await tick();
	assert.equal(gotB, false, "espera a que terminen las vueltas con «a»");
	a1();
	await tick();
	assert.equal(gotB, false);
	a2();
	const releaseB = await b;
	assert.deepEqual(unloaded, ["a>a", "a>b"]);
	assert.equal(gate.currentGatedModel()?.model, "b");
	releaseB();
	releaseB(); // soltar dos veces no rompe la cuenta
	const again = await gate.acquireModel(target("b"));
	again();
	assert.deepEqual(unloaded, ["a>a", "a>b"]);
});

test("los modelos de la nube no esperan turno", async () => {
	assert.equal(target("x", "openrouter"), null);
	const hold = await gate.acquireModel(target("a"));
	const cloud = await gate.acquireModel(null);
	cloud();
	hold();
});

test("se puede cancelar mientras espera", async () => {
	const hold = await gate.acquireModel(target("a"));
	const ctrl = new AbortController();
	const waiting = gate.acquireModel(target("b"), ctrl.signal);
	ctrl.abort();
	await assert.rejects(waiting, /detenida/);
	hold();
	await tick();
	assert.deepEqual(unloaded, ["a>a"], "nadie quedó esperando «b»: no se descarga «a»");
});

test("modelo de un agente: mismo proveedor usa lo de Ajustes, otro usa su preset", () => {
	setConfig({ llmProvider: "ollama", llmModel: "qwen3:8b", llmBaseUrl: "http://192.168.1.5:11434", llmApiKey: "clave-ajustes" });
	const same = resolveLLMSettings({ provider: "ollama", model: "llama3.2:3b" });
	assert.equal(same.baseUrl, "http://192.168.1.5:11434");
	assert.equal(same.model, "llama3.2:3b");
	assert.equal(same.apiKey, "clave-ajustes");

	process.env.OPENROUTER_API_KEY = "clave-env";
	const other = resolveLLMSettings({ provider: "openrouter", model: "openai/gpt-4o-mini" });
	assert.equal(other.baseUrl, "https://openrouter.ai/api/v1");
	assert.equal(other.apiKey, "clave-env", "la clave de Ajustes es de otro proveedor");
	delete process.env.OPENROUTER_API_KEY;

	const own = resolveLLMSettings({ provider: "lmstudio", baseUrl: "http://otro:1234/v1/" });
	assert.equal(own.baseUrl, "http://otro:1234/v1");
	assert.equal(own.model, "local-model", "sin modelo: el del preset");

	assert.deepEqual(resolveLLMSettings(), resolveLLMSettings({ provider: "ollama" }), "sin ref, lo de siempre");

	setModelTuning("ollama", "llama3.2:3b", { maxToolIterations: 3 });
	assert.equal(activeModelTuning({ provider: "ollama", model: "llama3.2:3b" }).maxToolIterations, 3);
	assert.notEqual(activeModelTuning().maxToolIterations, 3);
	assert.equal(modelSupportsVision("gpt-4o", "auto", "openrouter"), true);
});
