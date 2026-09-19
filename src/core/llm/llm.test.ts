import { test, before, after } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamFilter } from "./streamFilter.js";
import { parseTextToolCalls } from "./textTools.js";
import { createLLMClient } from "./client.js";
import type { LLMSettings } from "./providers.js";
import type { ToolDef } from "./LLMClient.js";
import { parseConfig } from "../../config/config.js";

// ---------- StreamFilter ----------

function filterAll(chunks: string[]): string {
	let out = "";
	const f = new StreamFilter((t) => (out += t));
	for (const c of chunks) f.push(c);
	f.flush();
	return out;
}

test("StreamFilter oculta <think> aunque la etiqueta llegue partida", () => {
	strictEqual(filterAll(["<thi", "nk>razonando...</th", "ink>Hola", " mundo"]), "Hola mundo");
});

test("StreamFilter oculta <tool_call> y deja pasar otros '<'", () => {
	strictEqual(filterAll(["a < b ", '<tool_call>{"name":"x"}</tool_call>', "fin"]), "a < b fin");
});

// ---------- textTools ----------

test("parseTextToolCalls lee el formato <tool_call>", () => {
	const calls = parseTextToolCalls('<tool_call>{"name": "get_time", "arguments": {"timezone": "UTC"}}</tool_call>', new Set(["get_time"]));
	deepStrictEqual(calls, [{ name: "get_time", args: { timezone: "UTC" } }]);
});

test("parseTextToolCalls acepta JSON suelto solo si la tool existe", () => {
	strictEqual(parseTextToolCalls('{"name": "get_time", "arguments": {}}', new Set(["get_time"])).length, 1);
	strictEqual(parseTextToolCalls('{"name": "otra", "arguments": {}}', new Set(["get_time"])).length, 0);
});

// ---------- Config ----------

test("parseConfig migra el formato viejo (ollamaModel, etc.)", () => {
	const cfg = parseConfig({ llmProvider: "ollama", ollamaModel: "qwen3:8b", ollamaBaseUrl: "http://pc:11434" });
	strictEqual(cfg.llmProvider, "ollama");
	strictEqual(cfg.llmModel, "qwen3:8b");
	strictEqual(cfg.llmBaseUrl, "http://pc:11434");
});

test("parseConfig usa defaults ante valores inválidos", () => {
	const cfg = parseConfig({ llmProvider: "nope", maxToolIterations: 999, approvalMode: "x" });
	strictEqual(cfg.llmProvider, "ollama");
	strictEqual(cfg.maxToolIterations, 10);
	strictEqual(cfg.approvalMode, "ask");
});

// ---------- Cliente contra un servidor falso ----------

type Handler = (path: string, body: Record<string, unknown>) => { status?: number; json?: unknown; ndjson?: unknown[]; sse?: unknown[] };
let server: Server;
let baseUrl = "";
let handler: Handler = () => ({ json: {} });
const requests: { path: string; body: Record<string, unknown> }[] = [];

before(async () => {
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const body = raw ? JSON.parse(raw) : {};
			requests.push({ path: req.url ?? "", body });
			const r = handler(req.url ?? "", body);
			res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
			if (r.ndjson) res.end(r.ndjson.map((l) => JSON.stringify(l)).join("\n") + "\n");
			else if (r.sse) res.end(r.sse.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n");
			else res.end(JSON.stringify(r.json ?? {}));
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

function settings(dialect: "ollama" | "openai", extra: Partial<LLMSettings> = {}): () => LLMSettings {
	return () => ({
		provider: dialect === "ollama" ? "ollama" : "custom",
		dialect,
		baseUrl: dialect === "ollama" ? baseUrl : `${baseUrl}/v1`,
		model: "test-model",
		apiKey: "",
		local: true,
		headers: { "Content-Type": "application/json" },
		contextWindow: 4096,
		timeoutMs: 5000,
		toolMode: "auto",
		...extra,
	});
}

const TOOLS: ToolDef[] = [
	{ type: "function", function: { name: "get_weather", description: "clima", parameters: { type: "object", properties: { city: { type: "string" } } } } },
];

test("Ollama: los argumentos llegan como objeto y se pasan bien a la tool", async () => {
	requests.length = 0;
	let turn = 0;
	handler = () =>
		turn++ === 0
			? { json: { message: { content: "", tool_calls: [{ function: { name: "get_weather", arguments: { city: "Madrid" } } }] } } }
			: { json: { message: { content: "Hace sol en Madrid." } } };

	const seen: Record<string, unknown>[] = [];
	const reply = await createLLMClient(settings("ollama")).chatWithTools([{ role: "user", content: "clima?" }], TOOLS, async (_n, args) => {
		seen.push(args);
		return { ok: true, content: "Soleado, 25°C" };
	});

	strictEqual(reply, "Hace sol en Madrid.");
	deepStrictEqual(seen, [{ city: "Madrid" }]);
	strictEqual(requests[0].path, "/api/chat");
	strictEqual((requests[0].body.options as { num_ctx: number }).num_ctx, 4096);
	// La segunda petición incluye el resultado con el nombre de la tool.
	const msgs = requests[1].body.messages as { role: string; tool_name?: string; content: string }[];
	const toolMsg = msgs.find((m) => m.role === "tool");
	strictEqual(toolMsg?.tool_name, "get_weather");
	strictEqual(toolMsg?.content, "Soleado, 25°C");
});

test("OpenAI streaming: une los trozos de tool_calls y transmite el texto", async () => {
	let turn = 0;
	handler = () =>
		turn++ === 0
			? {
					sse: [
						{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: '{"ci' } }] } }] },
						{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Lima"}' } }] } }] },
					],
				}
			: { sse: [{ choices: [{ delta: { content: "<think>hmm</think>En Lima " } }] }, { choices: [{ delta: { content: "llueve." } }] }] };

	let streamed = "";
	const seen: Record<string, unknown>[] = [];
	const reply = await createLLMClient(settings("openai")).chatWithTools(
		[{ role: "user", content: "clima?" }],
		TOOLS,
		async (_n, args) => {
			seen.push(args);
			return { ok: true, content: "lluvia" };
		},
		{ onDelta: (c) => (streamed += c) },
	);
	deepStrictEqual(seen, [{ city: "Lima" }]);
	strictEqual(reply, "En Lima llueve.");
	strictEqual(streamed, "En Lima llueve.");
});

test("Si el modelo no soporta tools, cambia a modo texto automáticamente", async () => {
	requests.length = 0;
	handler = (_p, body) => {
		if (body.tools) return { status: 400, json: { error: "registry.ollama.ai/library/gemma:2b does not support tools" } };
		const msgs = body.messages as { role: string; content: string }[];
		const last = msgs[msgs.length - 1];
		if (last.content.includes("<tool_result")) return { json: { message: { content: "Son las 10." } } };
		return { json: { message: { content: '<tool_call>{"name": "get_weather", "arguments": {"city": "Quito"}}</tool_call>' } } };
	};
	const seen: Record<string, unknown>[] = [];
	const reply = await createLLMClient(settings("ollama", { model: "gemma:2b" })).chatWithTools([{ role: "user", content: "x" }], TOOLS, async (_n, args) => {
		seen.push(args);
		return { ok: true, content: "ok" };
	});
	strictEqual(reply, "Son las 10.");
	deepStrictEqual(seen, [{ city: "Quito" }]);
	// El prompt de sistema incluye las instrucciones de modo texto.
	const sys = (requests[1].body.messages as { role: string; content: string }[])[0];
	ok(sys.content.includes("<tool_call>"));
});

test("Errores de conexión dan un mensaje claro", async () => {
	const client = createLLMClient(() => ({ ...settings("ollama")(), baseUrl: "http://127.0.0.1:1" }));
	await client.chat([{ role: "user", content: "hola" }]).then(
		() => ok(false, "debió fallar"),
		(err: Error) => ok(err.message.includes("No se pudo conectar"), err.message),
	);
});
