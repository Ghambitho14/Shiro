import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Las descargas de verdad (unloadOllama y unloadLmStudio) contra un servidor falso en 127.0.0.1.
const TMP = mkdtempSync(join(tmpdir(), "shiro-unload-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const gate = await import("./modelGate.js");
const { setLogLevel } = await import("../logger.js");
setLogLevel("error");

type Call = { method: string; url: string; body?: unknown; auth?: string };
type Handler = (req: IncomingMessage, body: unknown) => { status?: number; json?: unknown };

let calls: Call[] = [];
let handler: Handler = () => ({ status: 404 });

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const body = raw ? JSON.parse(raw) : undefined;
		calls.push({ method: req.method ?? "", url: req.url ?? "", body, auth: req.headers.authorization });
		const { status = 200, json = {} } = handler(req, body);
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(json));
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

beforeEach(() => {
	gate.resetModelGateForTests();
	gate.setUnloadersForTests(null);
	calls = [];
});

/** Usa un modelo y lo suelta enseguida, como una vuelta con el modelo. */
async function use(target: ReturnType<typeof gate.gateTarget>): Promise<void> {
	const release = await gate.acquireModel(target);
	release();
}

test("Ollama: descarga con keep_alive 0 todo lo cargado menos el modelo que se va a usar", async () => {
	let loaded = ["qwen3:8b", "otro-programa:7b"];
	handler = (req, body) => {
		if (req.method === "GET" && req.url === "/api/ps") return { json: { models: loaded.map((name) => ({ name })) } };
		if (req.method === "POST" && req.url === "/api/generate") {
			const b = body as { model: string; keep_alive: number };
			if (b.keep_alive === 0) loaded = loaded.filter((m) => m !== b.model);
			return { json: {} };
		}
		return { status: 404 };
	};
	const target = (model: string) => gate.gateTarget({ provider: "ollama", model, baseUrl: root });

	// La primera vez se descarga lo que dejó otro programa; el que se va a usar se queda.
	await use(target("qwen3:8b"));
	assert.deepEqual(
		calls.filter((c) => c.method === "POST").map((c) => c.body),
		[{ model: "otro-programa:7b", keep_alive: 0 }],
	);
	assert.deepEqual(loaded, ["qwen3:8b"]);

	// Al cambiar de modelo se descarga el anterior.
	calls = [];
	loaded.push("llama3.2:3b");
	await use(target("llama3.2:3b"));
	assert.deepEqual(
		calls.filter((c) => c.method === "POST").map((c) => c.body),
		[{ model: "qwen3:8b", keep_alive: 0 }],
	);
	assert.deepEqual(loaded, ["llama3.2:3b"]);
	assert.equal(gate.currentGatedModel()?.model, "llama3.2:3b");
});

test("LM Studio: lee /api/v1/models y descarga las instancias de los otros modelos, con su clave", async () => {
	handler = (req) => {
		if (req.method === "GET" && req.url === "/api/v1/models") {
			return {
				json: {
					models: [
						{ key: "qwen/qwen3.5-9b", loaded_instances: [{ id: "qwen/qwen3.5-9b" }] },
						{ key: "lunes-model", loaded_instances: [{ id: "lunes-model" }, { id: "lunes-model:2" }] },
						{ key: "sin-cargar", loaded_instances: [] },
					],
				},
			};
		}
		if (req.method === "POST" && req.url === "/api/v1/models/unload") return { json: {} };
		return { status: 404 };
	};
	const target = gate.gateTarget({ provider: "lmstudio", model: "qwen/qwen3.5-9b", baseUrl: `${root}/v1`, headers: { Authorization: "Bearer clave" } });

	await use(target);
	assert.deepEqual(
		calls.filter((c) => c.method === "POST").map((c) => c.body),
		[{ instance_id: "lunes-model" }, { instance_id: "lunes-model:2" }],
	);
	assert.ok(calls.every((c) => c.auth === "Bearer clave"), "la clave de LM Studio va en cada petición");
	assert.equal(gate.currentGatedModel()?.model, "qwen/qwen3.5-9b");
});

test("LM Studio viejo (sin /api/v1/models) o con error: no se descarga nada y el turno sigue", async () => {
	handler = () => ({ status: 404 });
	await use(gate.gateTarget({ provider: "lmstudio", model: "a", baseUrl: `${root}/v1` }));
	assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["GET /api/v1/models"]);

	calls = [];
	handler = () => ({ status: 500 });
	await use(gate.gateTarget({ provider: "lmstudio", model: "b", baseUrl: `${root}/v1` }));
	assert.ok(calls.length > 0);
	assert.ok(calls.every((c) => c.method === "GET"), "con un error no intenta descargar");
	assert.equal(gate.currentGatedModel()?.model, "b");
});
