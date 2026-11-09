import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { clearContextLimitCache, contextLimit } from "./contextLimit.js";
import type { LLMSettings } from "./providers.js";

let hits = 0;
const server: Server = createServer((req, res) => {
	hits++;
	res.setHeader("Content-Type", "application/json");
	if (req.url === "/api/v0/models") {
		res.end(
			JSON.stringify({
				data: [
					{ id: "qwen3-30b-a3b", state: "loaded", loaded_context_length: 40960, max_context_length: 40960 },
					{ id: "qwen/qwen3.6-35b-a3b", state: "not-loaded", max_context_length: 262144 },
				],
			}),
		);
		return;
	}
	if (req.url === "/v1/models") {
		res.end(JSON.stringify({ data: [{ id: "mi-modelo", max_model_len: 32768 }, { id: "otro", top_provider: { context_length: 128000 } }] }));
		return;
	}
	if (req.url === "/props") {
		res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
		return;
	}
	res.statusCode = 404;
	res.end("{}");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const settings = (over: Partial<LLMSettings>): LLMSettings => ({
	provider: "lmstudio",
	dialect: "openai",
	baseUrl: `${origin}/v1`,
	model: "qwen3-30b-a3b",
	apiKey: "",
	local: true,
	headers: {},
	contextWindow: 8192,
	timeoutMs: 1000,
	toolMode: "auto",
	...over,
});

test("LM Studio: el contexto con el que está cargado; sin cargar no se sabe", async () => {
	clearContextLimitCache();
	assert.equal(await contextLimit(settings({})), 40960);
	assert.equal(await contextLimit(settings({ model: "qwen/qwen3.6-35b-a3b" })), undefined);
});

test("Ollama de este equipo usa el num_ctx que manda Shiro, sin preguntar", async () => {
	const before = hits;
	assert.equal(await contextLimit(settings({ provider: "ollama", dialect: "ollama", baseUrl: origin, contextWindow: 16384 })), 16384);
	assert.equal(hits, before);
});

test("vLLM, OpenRouter y otros: la lista /models; se recuerda un rato", async () => {
	clearContextLimitCache();
	assert.equal(await contextLimit(settings({ provider: "vllm", model: "mi-modelo" })), 32768);
	assert.equal(await contextLimit(settings({ provider: "custom", model: "otro" })), 128000);
	const before = hits;
	assert.equal(await contextLimit(settings({ provider: "vllm", model: "mi-modelo" })), 32768);
	assert.equal(hits, before);
	assert.equal(await contextLimit(settings({ provider: "custom", model: "no-existe" })), undefined);
});

test("llama.cpp propio: /props", async () => {
	clearContextLimitCache();
	assert.equal(await contextLimit(settings({ provider: "llamacpp" })), 16384);
});

test("Si el servidor no responde, no lanza", async () => {
	clearContextLimitCache();
	assert.equal(await contextLimit(settings({ provider: "custom", baseUrl: "http://127.0.0.1:1/v1" })), undefined);
});
