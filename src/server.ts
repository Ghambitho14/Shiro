import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState } from "./store.js";
import { getConfig } from "./config/config.js";
import { getHealthState, setHealthActive } from "./core/health/HealthManager.js";
import { buildWorkspaceContext } from "./workspace.js";
import { vllmClient } from "./core/llm/vllmClient.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 1406;

const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function send(res: import("node:http").ServerResponse, status: number, body: string, contentType = "text/plain"): void {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: object): void {
	send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (method === "GET" && (url === "/api/state" || url.startsWith("/api/state?"))) {
		const state = getState();
		const vllm = vllmClient.getConfig();
		const config = getConfig();
		sendJson(res, 200, { name: state.name, vllm, abilities: config.abilities ?? null });
		return;
	}

	if (method === "GET" && (url === "/api/health" || url.startsWith("/api/health?"))) {
		const h = getHealthState();
		sendJson(res, 200, {
			lastActive: h.lastActive,
			status: h.status === "paused" ? "idle" : "active",
		});
		return;
	}

	if (method === "POST" && url === "/api/chat") {
		let body: string;
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let incoming: Array<{ role?: string; content?: string }>;
		try {
			const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
			if (!Array.isArray(parsed.messages)) {
				sendJson(res, 400, { error: "messages array required" });
				return;
			}
			incoming = parsed.messages.filter((m) => m && typeof m.content === "string");
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		const state = getState();
		const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
		const userContent = incoming.length > 0 ? incoming[incoming.length - 1].content ?? "" : "";
		if (!userContent.trim()) {
			sendJson(res, 400, { error: "Empty message" });
			return;
		}
		try {
			setHealthActive();
			const content = await runAgent(userContent, {
				llm: vllmClient,
				memory,
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: false,
			}, workspaceContext ?? undefined);
			sendJson(res, 200, { content });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 502, { error: message });
		}
		return;
	}

	if (method === "GET" && (url === "/" || url === "/index.html")) {
		const path = join(PUBLIC_DIR, "index.html");
		if (!existsSync(path)) {
			send(res, 404, "Not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(readFileSync(path, "utf-8"));
		return;
	}

	send(res, 404, "Not found");
});

server.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		console.error(`\n  El puerto ${PORT} ya está en uso. Cierra el otro proceso o usa otro puerto:`);
		console.error(`  Windows: set PORT=1407 && pnpm run dev`);
		console.error(`  Linux/Mac: PORT=1407 pnpm run dev\n`);
	} else {
		console.error(err);
	}
	process.exitCode = 1;
});

server.listen(PORT, () => {
	console.log(`Shiro web: http://127.0.0.1:${PORT}`);
	console.log(`vLLM: ${vllmClient.getConfig().baseUrl} (model: ${vllmClient.getConfig().model})`);
});
