import { test, before, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createLLMClient } from "./client.js";
import { LLMError } from "./LLMClient.js";
import type { LLMSettings } from "./providers.js";

// El «Tiempo máximo de espera» cuenta desde lo último que mandó el modelo:
// mientras siga escribiendo no se corta, aunque en total tarde más.

let server: Server;
let baseUrl = "";
let reply: (res: ServerResponse) => void = (res) => res.end();

const chunk = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
	server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			reply(res);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(() => {
	server.closeAllConnections();
	server.close();
});

function settings(timeoutMs: number): () => LLMSettings {
	return () => ({
		provider: "custom",
		dialect: "openai",
		baseUrl,
		model: "test-model",
		apiKey: "",
		local: false,
		headers: { "Content-Type": "application/json" },
		contextWindow: 4096,
		timeoutMs,
		toolMode: "auto",
	});
}

test("un modelo lento que sigue escribiendo no se corta aunque pase del tiempo de espera", async () => {
	reply = async (res) => {
		for (const word of ["uno ", "dos ", "tres ", "cuatro ", "cinco ", "seis"]) {
			res.write(chunk(word));
			await wait(250);
		}
		res.end("data: [DONE]\n\n");
	};
	const started = Date.now();
	const text = await createLLMClient(settings(800)).chat([{ role: "user", content: "hola" }], { onDelta: () => {} });
	strictEqual(text, "uno dos tres cuatro cinco seis");
	ok(Date.now() - started > 1200, "tardó más que el tiempo de espera en total");
});

test("si el modelo se queda callado, se corta con un error claro", async () => {
	reply = (res) => res.write(chunk("empiezo y me callo"));
	let error: unknown;
	try {
		await createLLMClient(settings(600)).chat([{ role: "user", content: "hola" }], { onDelta: () => {} });
	} catch (err) {
		error = err;
	}
	ok(error instanceof LLMError, String(error));
	strictEqual(error.kind, "timeout");
	ok(error.message.includes("se quedó callado"), error.message);
});
