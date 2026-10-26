import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-models-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
for (const k of ["SHIRO_LLM_PROVIDER", "SHIRO_LLM_MODEL", "SHIRO_LLM_BASE_URL", "SHIRO_LLM_API_KEY", "OPENROUTER_API_KEY"]) delete process.env[k];

const { setConfig } = await import("../../config/config.js");
const { setCatalogForTests } = await import("./catalog.js");
const { listProviderModels, parseModelList } = await import("./modelList.js");

/** Servidor falso compatible con OpenAI: guarda la cabecera Authorization de cada petición. */
let server: Server;
let base = "";
let status = 200;
const seenAuth: (string | undefined)[] = [];

before(async () => {
	server = createServer((req, res) => {
		res.writeHead(status, { "Content-Type": "application/json" });
		// Como LM Studio: dice qué modelos están cargados en memoria.
		if (req.url === "/api/v0/models") return res.end(JSON.stringify({ data: [{ id: "zeta", state: "loaded" }, { id: "alfa", state: "not-loaded" }] }));
		seenAuth.push(req.headers.authorization);
		res.end(JSON.stringify({ data: [{ id: "zeta" }, { id: "alfa", name: "Alfa 1" }, { id: "alfa" }] }));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
	server.close();
	rmSync(TMP, { recursive: true, force: true });
});

test("parseModelList lee el formato de Ollama y el de OpenAI", () => {
	assert.deepEqual(parseModelList({ models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }, { name: "gemma3:4b" }] }), [{ id: "gemma3:4b" }, { id: "qwen3:8b" }]);
	assert.deepEqual(parseModelList({ data: [{ id: "b" }, { id: "a", name: "Modelo A" }, { id: "b" }] }), [{ id: "a", name: "Modelo A" }, { id: "b" }]);
	assert.deepEqual(parseModelList({ cosa: 1 }), []);
});

test("pide la lista a la dirección del formulario, sin guardar nada antes", async () => {
	status = 200;
	const r = await listProviderModels({ provider: "custom", baseUrl: base });
	assert.equal(r.error, undefined);
	assert.deepEqual(
		r.models.map((m) => m.id),
		["alfa", "zeta"],
	);
});

test("LM Studio marca los modelos que ya están cargados", async () => {
	status = 200;
	const r = await listProviderModels({ provider: "lmstudio", baseUrl: base });
	assert.deepEqual(r.models, [{ id: "alfa", name: "Alfa 1" }, { id: "zeta", loaded: true }]);
});

test("la clave guardada solo va a la dirección guardada", async () => {
	status = 200;
	setConfig({ llmProvider: "custom", llmBaseUrl: base, llmApiKey: "secreta" });
	seenAuth.length = 0;
	await listProviderModels({ provider: "custom", baseUrl: base });
	assert.equal(seenAuth[0], "Bearer secreta");

	// Misma máquina, otra ruta: ya no es la dirección guardada.
	seenAuth.length = 0;
	await listProviderModels({ provider: "custom", baseUrl: `${base}/otra` });
	assert.equal(seenAuth[0], undefined);

	// La clave escrita en el formulario sí se usa.
	seenAuth.length = 0;
	await listProviderModels({ provider: "custom", baseUrl: `${base}/otra`, apiKey: "nueva" });
	assert.equal(seenAuth[0], "Bearer nueva");
	setConfig({ llmProvider: "ollama", llmBaseUrl: undefined, llmApiKey: undefined });
});

test("explica en español lo que falla", async () => {
	status = 401;
	assert.match((await listProviderModels({ provider: "custom", baseUrl: base })).error ?? "", /^El servidor pide una API key/);
	assert.match((await listProviderModels({ provider: "custom", baseUrl: base, apiKey: "mala" })).error ?? "", /no acepta la API key/);
	status = 200;

	assert.match((await listProviderModels({ provider: "custom", baseUrl: "ftp://equipo/v1" })).error ?? "", /no es válida/);

	// Un puerto donde no escucha nadie: el programa local está cerrado.
	const closed = createServer();
	await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
	const port = (closed.address() as AddressInfo).port;
	await new Promise<void>((r) => closed.close(() => r()));
	const r = await listProviderModels({ provider: "lmstudio", baseUrl: `http://127.0.0.1:${port}/v1` });
	assert.deepEqual(r.models, []);
	assert.match(r.error ?? "", /No encuentro LM Studio en .*¿Está abierto\? En LM Studio, enciende el servidor/);
});

test("OpenCode saca los modelos del catálogo, sin los retirados", async () => {
	setCatalogForTests({
		fetchedAt: Date.now(),
		providers: {
			opencode: {
				"kimi-k2.6": { name: "Kimi K2.6", api: "chat", vision: false, temperature: true, deprecated: false },
				"viejo-1": { name: "Viejo", api: "chat", vision: false, temperature: true, deprecated: true },
			},
		},
	});
	const r = await listProviderModels({ provider: "opencode" });
	assert.deepEqual(r, { models: [{ id: "kimi-k2.6", name: "Kimi K2.6" }] });
	setCatalogForTests(null);
});
