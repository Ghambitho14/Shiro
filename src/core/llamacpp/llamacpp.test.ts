import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-llamacpp-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
// Sin mirar los modelos reales de LM Studio ni de Ollama de quien corre las pruebas.
process.env.HOME = process.env.USERPROFILE = join(TMP, "home");
process.env.OLLAMA_MODELS = join(TMP, "home", "ollama-vacio");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { assignIds, findGgufModel, isGgufFile, ollamaName, scanGgufFolder, scanOllama } = await import("./models.js");
const { cudaMajorForDriver, pickAssets } = await import("./install.js");
const { buildServerArgs, explainFailure } = await import("./engine.js");
const { parseConfig, setConfig } = await import("../../config/config.js");
const { PROVIDER_PRESETS, resolveLLMSettings } = await import("../llm/providers.js");
const { contextOverflow } = await import("../llm/transports.js");

const gguf = (path: string, extra = "") => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `GGUF${extra}`);
};

// ---------- Modelos ----------

test("scanGgufFolder encuentra modelos, empareja el mmproj y lista solo la primera parte", () => {
	const root = join(TMP, "lmstudio");
	gguf(join(root, "pub", "Qwen3-8B-GGUF", "Qwen3-8B-Q5_K_M.gguf"));
	gguf(join(root, "pub", "Gemma-VL", "gemma-3-4b-Q4_K_M.gguf"));
	gguf(join(root, "pub", "Gemma-VL", "mmproj-gemma-3-4b-f16.gguf"));
	gguf(join(root, "pub", "Big", "Big-Q4-00001-of-00002.gguf"), "x".repeat(10));
	gguf(join(root, "pub", "Big", "Big-Q4-00002-of-00002.gguf"), "x".repeat(10));
	gguf(join(root, "pub", "Embed", "nomic-embed-text-v1.5.Q4_K_M.gguf"));
	writeFileSync(join(root, "pub", "notas.txt"), "nada");

	const found = scanGgufFolder(root, "lmstudio");
	const names = found.map((f) => f.name).sort();
	assert.deepEqual(names, ["Big-Q4", "Qwen3-8B-Q5_K_M", "gemma-3-4b-Q4_K_M"]);
	assert.match(found.find((f) => f.name === "gemma-3-4b-Q4_K_M")!.mmproj!, /mmproj-gemma/);
	assert.equal(found.find((f) => f.name === "Qwen3-8B-Q5_K_M")!.mmproj, undefined);
	// La parte 1 suma el tamaño de todas.
	assert.equal(found.find((f) => f.name === "Big-Q4")!.sizeBytes, 28);
});

test("assignIds distingue archivos con el mismo nombre", () => {
	const models = assignIds([
		{ name: "modelo", path: join("a", "uno", "modelo.gguf"), sizeBytes: 1, source: "carpeta" },
		{ name: "modelo", path: join("b", "dos", "modelo.gguf"), sizeBytes: 1, source: "carpeta" },
		{ name: "otro", path: join("c", "otro.gguf"), sizeBytes: 1, source: "shiro" },
	]);
	assert.deepEqual(
		models.map((m) => m.id),
		["modelo · uno", "modelo · dos", "otro"],
	);
});

test("scanOllama lee los manifiestos y solo acepta blobs GGUF", () => {
	const dir = join(TMP, "ollama");
	const hex = (c: string) => c.repeat(64);
	const manifest = (parts: string[], layers: object[]) => {
		const p = join(dir, "manifests", ...parts);
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, JSON.stringify({ layers }));
	};
	mkdirSync(join(dir, "blobs"), { recursive: true });
	writeFileSync(join(dir, "blobs", `sha256-${hex("a")}`), "GGUF....");
	writeFileSync(join(dir, "blobs", `sha256-${hex("b")}`), "no es gguf");
	writeFileSync(join(dir, "blobs", `sha256-${hex("c")}`), "GGUF proyector");
	manifest(["registry.ollama.ai", "library", "qwen3", "8b"], [
		{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${hex("a")}` },
		{ mediaType: "application/vnd.ollama.image.projector", digest: `sha256:${hex("c")}` },
	]);
	manifest(["registry.ollama.ai", "library", "roto", "latest"], [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${hex("b")}` }]);
	manifest(["registry.ollama.ai", "library", "nomic-embed-text", "latest"], [{ mediaType: "application/vnd.ollama.image.model", digest: `sha256:${hex("a")}` }]);

	const found = scanOllama(dir);
	assert.deepEqual(
		found.map((f) => f.name),
		["qwen3:8b"],
	);
	assert.equal(found[0].path, join(dir, "blobs", `sha256-${hex("a")}`));
	assert.equal(found[0].mmproj, join(dir, "blobs", `sha256-${hex("c")}`));
	assert.equal(ollamaName(["registry.ollama.ai", "user", "modelo", "q4"]), "user/modelo:q4");
	assert.equal(ollamaName(["hf.co", "org", "repo", "Q4_K_M"]), "hf.co/org/repo:Q4_K_M");
});

test("findGgufModel encuentra por nombre (data/models) o por ruta completa", () => {
	const file = join(process.env.SHIRO_DATA_DIR!, "models", "Mio-Q4_K_M.gguf");
	gguf(file);
	assert.equal(findGgufModel("mio-q4_k_m")?.path, file);
	assert.equal(findGgufModel("Mio-Q4_K_M.gguf")?.source, "shiro");
	const outside = join(TMP, "suelto", "Suelto.gguf");
	gguf(outside);
	assert.equal(findGgufModel(outside)?.path, outside);
	assert.equal(findGgufModel("no-existe"), undefined);
	assert.equal(isGgufFile(join(TMP, "lmstudio", "pub", "notas.txt")), false);
});

// ---------- Descarga ----------

const asset = (name: string, size = 1) => ({ name, size, browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/b11382/${name}` });
const RELEASE = {
	tag_name: "b11382",
	assets: [
		"cudart-llama-b11382-bin-ubuntu-cuda-12.8-x64.tar.gz",
		"cudart-llama-bin-win-cuda-12.4-x64.zip",
		"cudart-llama-bin-win-cuda-13.4-x64.zip",
		"llama-b11382-bin-macos-arm64.tar.gz",
		"llama-b11382-bin-ubuntu-cuda-12.8-x64.tar.gz",
		"llama-b11382-bin-ubuntu-vulkan-x64.tar.gz",
		"llama-b11382-bin-ubuntu-x64.tar.gz",
		"llama-b11382-bin-win-cpu-x64.zip",
		"llama-b11382-bin-win-cuda-12.4-x64.zip",
		"llama-b11382-bin-win-cuda-13.4-x64.zip",
		"llama-b11382-bin-win-vulkan-x64.zip",
	].map((n) => asset(n)),
};

test("pickAssets elige CUDA según el driver, con sus librerías", () => {
	const win13 = pickAssets(RELEASE, { platform: "win32", arch: "x64", backend: "cuda", cudaMajor: 13 });
	assert.equal(win13?.main.name, "llama-b11382-bin-win-cuda-13.4-x64.zip");
	assert.equal(win13?.extra?.name, "cudart-llama-bin-win-cuda-13.4-x64.zip");
	assert.equal(win13?.variant, "cuda-13.4");
	const win12 = pickAssets(RELEASE, { platform: "win32", arch: "x64", backend: "cuda", cudaMajor: cudaMajorForDriver("560.94") });
	assert.equal(win12?.main.name, "llama-b11382-bin-win-cuda-12.4-x64.zip");
	assert.equal(pickAssets(RELEASE, { platform: "win32", arch: "x64", backend: "cuda", cudaMajor: cudaMajorForDriver("531.0") }), null);
	assert.equal(cudaMajorForDriver("616.92"), 13);
});

test("pickAssets: Vulkan, CPU, Linux y Mac", () => {
	assert.equal(pickAssets(RELEASE, { platform: "win32", arch: "x64", backend: "vulkan" })?.main.name, "llama-b11382-bin-win-vulkan-x64.zip");
	assert.equal(pickAssets(RELEASE, { platform: "win32", arch: "x64", backend: "cpu" })?.main.name, "llama-b11382-bin-win-cpu-x64.zip");
	assert.equal(pickAssets(RELEASE, { platform: "linux", arch: "x64", backend: "cpu" })?.main.name, "llama-b11382-bin-ubuntu-x64.tar.gz");
	const linuxCuda = pickAssets(RELEASE, { platform: "linux", arch: "x64", backend: "cuda", cudaMajor: 13 });
	assert.equal(linuxCuda?.main.name, "llama-b11382-bin-ubuntu-cuda-12.8-x64.tar.gz");
	assert.equal(linuxCuda?.extra?.name, "cudart-llama-b11382-bin-ubuntu-cuda-12.8-x64.tar.gz");
	assert.equal(pickAssets(RELEASE, { platform: "darwin", arch: "arm64", backend: "metal" })?.main.name, "llama-b11382-bin-macos-arm64.tar.gz");
	assert.equal(pickAssets(RELEASE, { platform: "win32", arch: "ia32", backend: "cpu" }), null);
	// Una versión sin archivos (como las "nightly" sin compilar) no sirve.
	assert.equal(pickAssets({ tag_name: "v0.5.0", assets: [asset("nightly-tag.txt")] }, { platform: "win32", arch: "x64", backend: "vulkan" }), null);
});

// ---------- Motor ----------

test("buildServerArgs: contexto, puerto, reposo y visión solo cuando toca", () => {
	const model = { id: "Qwen3-8B-Q5_K_M", path: "C:\\m\\q.gguf", sizeBytes: 1, source: "lmstudio" as const, mmproj: "C:\\m\\mmproj.gguf" };
	const args = buildServerArgs({ exe: "llama-server", model, port: 5123, ctx: 8192, idleMinutes: 10, vision: true });
	const val = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(val("-m"), model.path);
	assert.equal(val("--host"), "127.0.0.1");
	assert.equal(val("--port"), "5123");
	assert.equal(val("-c"), "8192");
	assert.equal(val("--alias"), model.id);
	assert.equal(val("--sleep-idle-seconds"), "600");
	assert.equal(val("--mmproj"), model.mmproj);
	assert.ok(!args.includes("--api-key"), "la clave va por el entorno, no en la línea de comandos");
	const plain = buildServerArgs({ exe: "llama-server", model, port: 1, ctx: 4096, idleMinutes: 0, vision: false });
	assert.ok(!plain.includes("--sleep-idle-seconds"));
	assert.ok(!plain.includes("--mmproj"));
	// Automático: sin -c, llama.cpp elige el mayor contexto que quepa (sin bajar de 16K).
	const auto = buildServerArgs({ exe: "llama-server", model, port: 1, ctx: 0, idleMinutes: 10, vision: false });
	assert.ok(!auto.includes("-c"));
	assert.equal(auto[auto.indexOf("--fit-ctx") + 1], "16384");
});

test("buildServerArgs: rendimiento solo cuando no está en automático", () => {
	const model = { id: "m", path: "m.gguf", sizeBytes: 1, source: "carpeta" as const };
	const base = { exe: "llama-server", model, port: 1, ctx: 0, idleMinutes: 0, vision: false };
	const auto = buildServerArgs({ ...base, gpuLayers: "auto", kvCache: "f16", threads: 0, flashAttention: "auto" });
	for (const flag of ["-ngl", "-ctk", "-ctv", "-t", "-fa"]) assert.ok(!auto.includes(flag), flag);
	const tuned = buildServerArgs({ ...base, gpuLayers: 28, kvCache: "q8_0", threads: 6, flashAttention: "on" });
	const val = (flag: string) => tuned[tuned.indexOf(flag) + 1];
	assert.equal(val("-ngl"), "28");
	assert.equal(val("-ctk"), "q8_0");
	assert.equal(val("-ctv"), "q8_0");
	assert.equal(val("-t"), "6");
	assert.equal(val("-fa"), "on");
	assert.equal(buildServerArgs({ ...base, gpuLayers: "all" })[buildServerArgs({ ...base, gpuLayers: "all" }).indexOf("-ngl") + 1], "all");
	assert.match(explainFailure("llama_init_from_model: V cache quantization requires flash_attn", { model, ctx: 0 }), /flash attention/);
});

test("contextOverflow reconoce el error de contexto lleno de llama.cpp y de otros servidores", () => {
	assert.deepEqual(contextOverflow("exceed_context_size_error", "request (9907 tokens) exceeds the available context size (8192 tokens), try increasing it"), {
		used: 9907,
		max: 8192,
	});
	assert.deepEqual(contextOverflow("invalid_request_error", "This model's maximum context length is 128000 tokens."), {});
	assert.equal(contextOverflow("", "model not found"), null);
});

test("explainFailure traduce los errores típicos de llama.cpp", () => {
	const model = { id: "m", path: "C:\\m.gguf", sizeBytes: 1, source: "carpeta" as const };
	assert.match(explainFailure("llama_model_load: error loading model: unknown model architecture: 'foo'", { model, ctx: 8192 }), /Actualizar/);
	assert.match(explainFailure("ggml_backend_cuda_buffer_type_alloc_buffer: allocating 9000 MiB on device 0: cudaMalloc failed: out of memory", { model, ctx: 32768 }), /32768/);
	assert.match(explainFailure("", { model, ctx: 8192, exitCode: 3221225781 }), /librerías/);
	assert.match(explainFailure("gguf_init_from_file_impl: invalid magic characters", { model, ctx: 8192 }), /dañado/);
});

// ---------- Configuración ----------

test("parseConfig acepta gguf y los ajustes de llama.cpp", () => {
	const cfg = parseConfig({ llmProvider: "gguf", llamaBackend: "cuda", llamaIdleMinutes: 0, ggufFolders: ["D:\\Modelos"] });
	assert.equal(cfg.llmProvider, "gguf");
	assert.equal(cfg.llamaBackend, "cuda");
	assert.equal(cfg.llamaIdleMinutes, 0);
	assert.deepEqual(cfg.ggufFolders, ["D:\\Modelos"]);
	const def = parseConfig({ llamaBackend: "otro", llamaIdleMinutes: -3 });
	assert.equal(def.llamaBackend, "auto");
	assert.equal(def.llamaIdleMinutes, 10);
	assert.equal(def.llamaContext, 0, "contexto automático por defecto");
});

test("resolveLLMSettings con gguf: dialecto OpenAI, local y sin dirección ni clave del usuario", () => {
	setConfig({ llmProvider: "gguf", llmModel: "Mio-Q4_K_M", llmBaseUrl: undefined, llmApiKey: "no-se-usa" });
	const s = resolveLLMSettings();
	assert.equal(s.provider, "gguf");
	assert.equal(s.dialect, "openai");
	assert.equal(s.local, true);
	assert.equal(s.apiKey, "");
	assert.equal(s.baseUrl, PROVIDER_PRESETS.gguf.baseUrl);
	assert.equal(s.model, "Mio-Q4_K_M");
	assert.equal(s.headers.Authorization, undefined);
	assert.equal(s.contextWindow, 0, "sin llama.cpp abierto, el ajuste (0 = automático)");
});
