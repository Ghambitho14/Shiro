import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCatalog, setCatalogForTests } from "./catalog.js";
import { costOf, priceFor } from "./pricing.js";
import { runAgent } from "../agent/Agent.js";
import type { LLMClient } from "./LLMClient.js";
import type { ResponseStats } from "../agent/runLog.js";

const catalog = () =>
	extractCatalog({
		opencode: { models: { "kimi-k2.6": { name: "Kimi K2.6", cost: { input: 0.6, output: 2.5 } }, "gratis-free": { cost: { input: 0, output: 0 } } } },
		"opencode-go": { models: { "glm-5.3-flash": { name: "GLM 5.3 Flash", cost: { input: 0.15, output: 0.6 } } } },
		openrouter: { models: { "moonshotai/kimi-k2": { cost: { input: 0.5, output: 2 } }, "sin/precio": {} } },
		"ollama-cloud": { models: { "qwen3-coder": { cost: { input: 1, output: 1 } } } },
	});

test("el catálogo guarda los precios de OpenRouter, solo el precio", () => {
	const c = catalog();
	assert.deepEqual(c.prices, { openrouter: { "moonshotai/kimi-k2": { input: 0.5, output: 2 } } });
	assert.equal(c.providers["opencode-go"]?.["glm-5.3-flash"]?.price?.input, 0.15);
	assert.equal((c.providers as Record<string, unknown>)["ollama-cloud"], undefined);
});

test("precio por proveedor: OpenCode Zen y OpenRouter se pagan; OpenCode Go es de tu plan; lo local no tiene", () => {
	setCatalogForTests(catalog());
	assert.deepEqual(priceFor("opencode", "kimi-k2.6"), { price: { input: 0.6, output: 2.5 }, plan: false });
	// Con el prefijo de OpenCode o con el nombre visible.
	assert.deepEqual(priceFor("opencode-go", "opencode-go/glm-5.3-flash"), { price: { input: 0.15, output: 0.6 }, plan: true });
	assert.deepEqual(priceFor("opencode-go", "GLM 5.3 Flash"), { price: { input: 0.15, output: 0.6 }, plan: true });
	assert.deepEqual(priceFor("openrouter", "moonshotai/kimi-k2"), { price: { input: 0.5, output: 2 }, plan: false });
	assert.equal(priceFor("openrouter", "sin/precio"), undefined);
	assert.equal(priceFor("opencode", "no-existe"), undefined);
	for (const local of ["ollama", "lmstudio", "llamacpp", "gguf"]) assert.equal(priceFor(local, "qwen3:8b"), undefined, local);
	assert.equal(priceFor("ollama-cloud", "qwen3-coder"), undefined);
	assert.equal(priceFor("custom", "lo-que-sea"), undefined);
	setCatalogForTests(null);
});

test("coste: tokens por el precio por millón", () => {
	assert.equal(costOf({ input: 1_000_000, output: 0 }, { input: 0.6, output: 2.5 }), 0.6);
	assert.equal(costOf({ input: 2000, output: 500 }, { input: 0.6, output: 2.5 }), 0.00245);
	assert.equal(costOf({ input: 5000, output: 900 }, { input: 0, output: 0 }), 0);
});

/** Un modelo falso que escribe en streaming: primero pensando (nada visible), luego el texto. */
function streamingLLM(provider: string, model: string): LLMClient {
	const reply = async (opts?: { onDelta?: (c: string) => void; onUsage?: (u: { input: number; output: number }) => void }) => {
		opts?.onUsage?.({ input: 2000, output: 500 });
		await new Promise((r) => setTimeout(r, 30));
		opts?.onDelta?.("  ");
		await new Promise((r) => setTimeout(r, 30));
		opts?.onDelta?.("Hola");
		opts?.onDelta?.(", ¿qué tal?");
		return "Hola, ¿qué tal?";
	};
	return {
		chat: async (_m, opts) => reply(opts),
		chatWithTools: async (_m, _d, _exec, opts) => reply(opts),
		getConfig: () => ({ provider, model, baseUrl: "http://x", local: provider === "ollama" }),
	};
}

test("la respuesta dice cuándo salió la primera palabra y cuánto costó", async () => {
	setCatalogForTests(catalog());
	let stats: ResponseStats | undefined;
	await runAgent("hola", { llm: streamingLLM("opencode", "kimi-k2.6"), agentName: "Aku", mcp: false, textOnly: true, onStreamDelta: () => {}, onStats: (s) => (stats = s) });
	assert.ok(stats?.firstTextMs !== undefined && stats.firstTextMs >= 50, `primera palabra: ${stats?.firstTextMs}`);
	assert.equal(stats?.cost, 0.00245);
	assert.equal(stats?.plan, undefined);

	// Suscripción: el coste va marcado como de tu plan.
	await runAgent("hola", { llm: streamingLLM("opencode-go", "glm-5.3-flash"), agentName: "Aku", mcp: false, textOnly: true, onStreamDelta: () => {}, onStats: (s) => (stats = s) });
	assert.equal(stats?.plan, true);
	assert.equal(stats?.cost, 0.0006);

	// Local y sin streaming: ni coste ni primera palabra.
	await runAgent("hola", { llm: streamingLLM("ollama", "qwen3:8b"), agentName: "Aku", mcp: false, textOnly: true, onStats: (s) => (stats = s) });
	assert.deepEqual(stats, {});
	setCatalogForTests(null);
});
