import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-tuning-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
for (const k of ["SHIRO_LLM_PROVIDER", "SHIRO_LLM_MODEL", "SHIRO_LLM_BASE_URL"]) delete process.env[k];
after(() => rmSync(TMP, { recursive: true, force: true }));

const { getConfig, parseConfig, setConfig } = await import("../../config/config.js");
const ms = await import("./modelSettings.js");
const { resolveLLMSettings } = await import("./providers.js");
const { getMaxToolIterations } = await import("./toolRuntime.js");
const { resolveTools } = await import("../agent/Agent.js");
const { LITE_TOOLS } = await import("../tools/ToolRegistry.js");

test("prioridad: lo propio del modelo, luego lo general, luego lo de fábrica", () => {
	setConfig({ temperature: 0.5, toolProfile: "auto", maxToolIterations: 10 });
	ms.setModelTuning("gguf", "qwen3:8b", { temperature: 0.2, thinking: "off", toolProfile: "full" });
	const t = ms.getModelTuning("gguf", "qwen3:8b");
	assert.equal(t.temperature, 0.2);
	assert.equal(t.thinking, "off");
	assert.equal(t.toolProfile, "full");
	assert.equal(t.maxToolIterations, 10, "lo que no se tocó sigue al general");
	assert.equal(t.kvCache, "f16", "valor de fábrica");
	const other = ms.getModelTuning("gguf", "otro");
	assert.equal(other.temperature, 0.5);
	assert.equal(other.thinking, "auto");
});

test("solo se guarda lo que difiere de los generales; null vuelve a los generales", () => {
	setConfig({ maxToolIterations: 10, contextWindow: 8192 });
	assert.deepEqual(ms.setModelTuning("ollama", "qwen3:8b", { maxToolIterations: 10, contextSize: 16384 }), { contextSize: 16384 });
	assert.deepEqual(ms.ownTuning("ollama", "qwen3:8b"), { contextSize: 16384 });
	assert.equal(ms.setModelTuning("ollama", "qwen3:8b", null), null);
	assert.equal(ms.ownTuning("ollama", "qwen3:8b"), null);
	// Igual que los generales = no hace falta guardar nada.
	assert.equal(ms.setModelTuning("ollama", "qwen3:8b", { maxToolIterations: 10 }), null);
});

test("generales: el contexto de llama.cpp y el de Ollama van por separado", () => {
	ms.setGeneralTuning("gguf", { contextSize: 0, kvCache: "q8_0" });
	ms.setGeneralTuning("ollama", { contextSize: 16384 });
	assert.equal(getConfig().llamaContext, 0);
	assert.equal(getConfig().contextWindow, 16384);
	assert.equal(getConfig().llamaKvCache, "q8_0");
	assert.equal(ms.getModelTuning("gguf", "x").contextSize, 0);
	assert.equal(ms.getModelTuning("ollama", "x").contextSize, 16384);
	// Sin temperatura = la del modelo.
	ms.setGeneralTuning("ollama", {});
	assert.equal(getConfig().temperature, undefined);
});

test("claves con / y :, y entradas inválidas no rompen la configuración", () => {
	const cfg = parseConfig({
		modelSettings: {
			"openrouter|openai/gpt-4o-mini": { temperature: 0.3 },
			"gguf|roto": "no es un objeto",
			"gguf|malo": { temperature: 9, kvCache: "zzz", threads: 4 },
		},
	});
	assert.equal(cfg.modelSettings["openrouter|openai/gpt-4o-mini"].temperature, 0.3);
	assert.deepEqual(cfg.modelSettings["gguf|roto"], {});
	assert.equal(cfg.modelSettings["gguf|malo"].temperature, undefined);
	assert.equal(cfg.modelSettings["gguf|malo"].kvCache, undefined);
	assert.equal(cfg.modelSettings["gguf|malo"].threads, 4);
	assert.deepEqual(ms.parseTuningInput({ temperature: null, maxTokens: "", thinking: "off", otro: 1 }), { thinking: "off" });
});

test("el modelo activo usa sus ajustes: temperatura, pensar, largo, contexto, herramientas y pasos", () => {
	setConfig({ llmProvider: "ollama", llmModel: "qwen3:8b", contextWindow: 8192, toolProfile: "auto", maxToolIterations: 10, saver: "off" });
	ms.setModelTuning("ollama", "qwen3:8b", { temperature: 0.1, thinking: "off", maxTokens: 512, contextSize: 32768, toolProfile: "full", maxToolIterations: 3 });
	const s = resolveLLMSettings();
	assert.equal(s.temperature, 0.1);
	assert.equal(s.thinking, "off");
	assert.equal(s.maxTokens, 512);
	assert.equal(s.contextWindow, 32768);
	assert.equal(getMaxToolIterations(), 3);
	// Con "todas", un modelo local ya no se limita a las herramientas esenciales.
	const tools = resolveTools(undefined, true, true);
	assert.ok(tools === undefined || tools.some((t) => !LITE_TOOLS.includes(t)));
	// Con los generales ("auto") vuelve a las esenciales.
	ms.setModelTuning("ollama", "qwen3:8b", null);
	assert.equal(getMaxToolIterations(), 10);
	assert.ok(resolveTools(undefined, true, true)?.every((t) => LITE_TOOLS.includes(t) || t.startsWith("mcp__") || t.startsWith("pc_")));
});

test("Ollama Cloud: habla el formato de Ollama con ollama.com y la clave de OLLAMA_API_KEY", () => {
	process.env.OLLAMA_API_KEY = "clave-ollama";
	try {
		setConfig({ llmProvider: "ollama-cloud", llmModel: "gpt-oss:120b", llmBaseUrl: "", llmApiKey: "" });
		const s = resolveLLMSettings();
		assert.equal(s.dialect, "ollama");
		assert.equal(s.baseUrl, "https://ollama.com");
		assert.equal(s.local, false);
		assert.equal(s.headers.Authorization, "Bearer clave-ollama");
	} finally {
		delete process.env.OLLAMA_API_KEY;
		setConfig({ llmProvider: "ollama", llmModel: "qwen3:8b" });
	}
});

test("modo ahorro: automático en locales y OpenCode, no en OpenRouter; limita pasos y resultados", async () => {
	const { saverOn } = await import("./providers.js");
	const { normalizeToolResult } = await import("./toolRuntime.js");
	setConfig({ llmProvider: "ollama", llmModel: "qwen3:8b", maxToolIterations: 10, saver: "auto", modelSettings: {} });
	assert.equal(saverOn(), true);
	assert.equal(getMaxToolIterations(), 8);
	assert.ok(normalizeToolResult("x".repeat(10_000)).length < 4100);
	// Code, Hacking y Planear no aplican sus límites aunque esté encendido, y tienen el triple de pasos.
	assert.equal(getMaxToolIterations(undefined, false), 10);
	assert.equal(getMaxToolIterations(undefined, false, true), 30);
	assert.equal(normalizeToolResult("x".repeat(10_000), undefined, false).length, 10_000);
	// Con poco contexto, cada resultado ocupa como mucho una sexta parte (y nunca menos de 1.500 letras).
	const { toolResultLimit, toolResultsBudget } = await import("./toolRuntime.js");
	assert.equal(toolResultLimit(undefined, false), 12_000);
	assert.equal(toolResultLimit(undefined, false, 8192), Math.floor((8192 * 3.5) / 6));
	assert.equal(toolResultLimit(undefined, false, 1000), 1500);
	assert.equal(toolResultLimit(undefined, false, 200_000), 12_000);
	assert.equal(toolResultLimit(undefined, true, 200_000), 4000);
	// Lo que pueden sumar los resultados de una respuesta antes de recortar los viejos.
	assert.equal(toolResultsBudget(10_000, true), 14_000);
	assert.equal(toolResultsBudget(undefined, true), 24_000);
	assert.equal(toolResultsBudget(undefined, false), 80_000);
	// En automático, la nube "normal" lo tiene apagado; OpenCode encendido.
	assert.equal(saverOn({ provider: "openrouter", model: "openai/gpt-4o-mini" }), false);
	assert.equal(saverOn({ provider: "opencode-go", model: "glm-5.3-flash" }), true);
	assert.equal(getMaxToolIterations({ provider: "openrouter", model: "openai/gpt-4o-mini" }), 10);
	// Apagado a mano para un modelo: vuelve a lo normal.
	ms.setModelTuning("ollama", "qwen3:8b", { saver: "off" });
	assert.equal(saverOn(), false);
	assert.equal(normalizeToolResult("x".repeat(10_000)).length, 10_000);
	ms.setModelTuning("ollama", "qwen3:8b", null);
});
