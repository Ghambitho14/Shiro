import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
	completeDetails,
	detailsFromLmStudio,
	detailsFromOllama,
	detailsFromOpenAI,
	estimateSizeBytes,
	gpuFit,
	paramsFromName,
	priceFromPerMillion,
	priceFromPerToken,
	quantFromName,
} from "./modelInfo.js";
import { parseModelList } from "./modelList.js";
import { extractCatalog } from "./catalog.js";
import { parseNvidiaSmi } from "../llamacpp/install.js";

const GB = 1024 ** 3;

test("parámetros y cuantización salen del nombre del modelo", () => {
	const cases: [string, string | null, string | null][] = [
		["Qwen3-8B-Q4_K_M.gguf", "8B", "Q4_K_M"],
		["qwen3.5-9b", "9B", null],
		["llama3.1:8b-instruct-q8_0", "8B", "Q8_0"],
		["LFM3-1.7B-Q4_0.gguf", "1.7B", "Q4_0"],
		["Qwen3-30B-A3B-IQ4_XS.gguf", "30B-A3B", "IQ4_XS"],
		["gemma3:270m", "270M", null],
		["gpt-oss-20b-mxfp4.gguf", "20B", "MXFP4"],
		["mistral-7b-instruct-v0.3.f16.gguf", "7B", "F16"],
		["qwen3-coder", null, null],
		["phi4", null, null],
	];
	for (const [name, params, quant] of cases) {
		assert.equal(paramsFromName(name), params, `${name} params`);
		assert.equal(quantFromName(name), quant, `${name} quant`);
	}
});

test("tamaño estimado: parámetros × bits por peso", () => {
	const q4 = estimateSizeBytes("8B", "Q4_K_M")!;
	assert.ok(q4 > 4.5e9 && q4 < 5.2e9, String(q4));
	assert.equal(estimateSizeBytes("7B", "F16"), 14e9);
	assert.ok(estimateSizeBytes("30B-A3B", "Q4_K_M")! > 17e9, "los MoE ocupan por el total, no por los activos");
	assert.equal(estimateSizeBytes("8B", "raro"), null);
});

test("si cabe en la tarjeta: con sitio para la conversación, justo o no", () => {
	const vram = 12 * GB;
	assert.equal(gpuFit(5 * GB, vram), "fits");
	assert.equal(gpuFit(10.5 * GB, vram), "tight");
	assert.equal(gpuFit(13 * GB, vram), "no");
});

test("completeDetails: lo del proveedor manda, lo que falta sale del nombre", () => {
	assert.deepEqual(completeDetails("qwen3-8b-q4_k_m.gguf", { sizeBytes: 5 * GB }, 12 * GB), { params: "8B", quant: "Q4_K_M", sizeBytes: 5 * GB, fit: "fits" });
	// Un 14B en Q4_K_M ocupa ~8,4 GB: en 9 GB caben los pesos, pero queda poco para la conversación.
	const est = completeDetails("qwen3-14b", { quant: "Q4_K_M" }, 9 * GB);
	assert.equal(est.sizeEstimated, true);
	assert.equal(est.fit, "tight");
	// Sin tarjeta conocida no se dice si cabe.
	assert.equal(completeDetails("x-8b-q4_0", {}, undefined).fit, undefined);
	assert.deepEqual(completeDetails("modelo", {}, 12 * GB), {});
});

test("precios: por token (OpenRouter) y por millón (models.dev)", () => {
	assert.deepEqual(priceFromPerToken({ prompt: "0.00000015", completion: "0.0000006" }), { input: 0.15, output: 0.6 });
	assert.deepEqual(priceFromPerToken({ prompt: "0", completion: "0" }), { input: 0, output: 0 });
	assert.equal(priceFromPerToken({ prompt: "-1", completion: "-1" }), undefined, "precio variable: no se inventa");
	assert.deepEqual(priceFromPerMillion({ input: 0.6, output: 2.2, cache_read: 0.1 }), { input: 0.6, output: 2.2 });
	assert.equal(priceFromPerMillion(undefined), undefined);
});

test("datos de cada servidor: Ollama, LM Studio y formato OpenAI", () => {
	assert.deepEqual(detailsFromOllama({ name: "qwen3:8b", size: 5_200_000_000, details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } }), {
		sizeBytes: 5_200_000_000,
		params: "8.2B",
		quant: "Q4_K_M",
	});
	assert.deepEqual(detailsFromOllama({ details: { parameter_size: "8.0B", quantization_level: "unknown" } }), { params: "8B" });
	assert.deepEqual(detailsFromLmStudio({ id: "qwen", quantization: "Q4_K_M", max_context_length: 32768 }), { quant: "Q4_K_M", context: 32768 });
	assert.deepEqual(detailsFromOpenAI({ id: "x", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" } }), { context: 128000, price: { input: 1, output: 2 } });
	// La lista de modelos conserva esos datos.
	const list = parseModelList({ models: [{ name: "qwen3:8b", size: 5e9, details: { parameter_size: "8B", quantization_level: "Q4_K_M" } }] });
	assert.deepEqual(list, [{ id: "qwen3:8b", sizeBytes: 5e9, params: "8B", quant: "Q4_K_M" }]);
});

test("el catálogo de OpenCode guarda el precio de cada modelo", () => {
	const cat = extractCatalog({
		"opencode-go": { npm: "@ai-sdk/openai-compatible", models: { "kimi-k3": { name: "Kimi K3", cost: { input: 0.6, output: 2.5 } }, gratis: { name: "Gratis", cost: { input: 0, output: 0 } }, raro: { name: "Raro" } } },
	});
	const m = cat.providers["opencode-go"]!;
	assert.deepEqual(m["kimi-k3"].price, { input: 0.6, output: 2.5 });
	assert.deepEqual(m.gratis.price, { input: 0, output: 0 });
	assert.equal(m.raro.price, undefined);
	assert.equal(cat.format, 3);
});

test("nvidia-smi: nombre, driver y memoria de la tarjeta", () => {
	const n = parseNvidiaSmi("NVIDIA GeForce RTX 3060, 616.92, 12288\r\n");
	assert.equal(n?.name, "NVIDIA GeForce RTX 3060");
	assert.equal(n?.vramBytes, 12 * GB);
	assert.ok(n?.cudaMajor, "con ese driver hay CUDA");
	assert.equal(parseNvidiaSmi("NVIDIA X, 550.1, [N/A]")?.vramBytes, undefined);
	assert.equal(parseNvidiaSmi(""), null);
});

test("la frase de la web (public/js/modelInfo.js)", async () => {
	const web = (await import(pathToFileURL(join(process.cwd(), "public", "js", "modelInfo.js")).href)) as {
		describeModel: (m: unknown, gpu: unknown) => { text: string; kind: string };
	};
	const gpu = { name: "NVIDIA GeForce RTX 3060", vramBytes: 12 * GB };
	const fits = web.describeModel({ params: "8B", quant: "Q4_K_M", sizeBytes: 5 * GB, fit: "fits" }, gpu);
	assert.equal(fits.kind, "ok");
	assert.match(fits.text, /^8B · Q4_K_M · 5 GB · cabe en tu tarjeta \(RTX 3060, 12 GB\)$/);
	assert.match(web.describeModel({ sizeBytes: 14 * GB, sizeEstimated: true, fit: "no" }, gpu).text, /≈14 GB · no cabe/);
	assert.match(web.describeModel({ price: { input: 0.15, output: 0.6 }, context: 131072 }, null).text, /128K de contexto · 0,15 \$ leídos · 0,6 \$ escritos por millón de tokens/);
	assert.equal(web.describeModel({ price: { input: 0, output: 0 } }, null).text, "gratis");
	assert.equal(web.describeModel({ context: 1_000_000 }, null).text, "1M de contexto");
	assert.equal(web.describeModel({ context: 128_000 }, null).text, "128K de contexto");
	assert.equal(web.describeModel(null, gpu).text, "");
});
