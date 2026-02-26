import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState } from "./store.js";
import { getConfig } from "./config.js";
import { getHealth, setHealthActive } from "./health.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getToolsDefinition, executeTool } from "./tools.js";
import { chatWithTools, getVllmConfig } from "./vllm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3780;

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

	// CORS básico para desarrollo
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// GET /api/state → nombre, vLLM, habilidades
	if (method === "GET" && (url === "/api/state" || url.startsWith("/api/state?"))) {
		const state = getState();
		const vllm = getVllmConfig();
		const config = getConfig();
		sendJson(res, 200, { name: state.name, vllm, abilities: config.abilities ?? null });
		return;
	}

	// GET /api/health → lastActive, status (vida y autonomía)
	if (method === "GET" && (url === "/api/health" || url.startsWith("/api/health?"))) {
		sendJson(res, 200, getHealth());
		return;
	}

	// POST /api/chat → { messages } → inyecta SOUL + memory, llama vLLM, actualiza health
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
		const config = getConfig();
		const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
		let systemContent = `Eres un asistente útil llamado ${state.name}. Responde en el mismo idioma que el usuario.

Herramientas de workspace: read_file(path), write_file(path, content), list_dir(path opcional). Úsalas para SOUL.md, MEMORY.md, memory/ y para actualizar memoria.

Herramientas de la PC del usuario: read_file_system(path), write_file_system(path, content), list_dir_system(path opcional). Cuando el usuario pregunte qué hay en su PC, qué carpetas hay, qué hay en Documentos (o en cualquier carpeta), DEBES llamar a list_dir_system: sin path para la raíz (carpeta de usuario), o con path como "Documents", "Desktop", etc., y luego responder con el listado real que devuelva la herramienta. No describas solo que tienes la herramienta; ejecútala y muestra el resultado.`;
		if (config.abilities?.trim()) systemContent += "\n\nHabilidades o instrucciones: " + config.abilities.trim();
		if (workspaceContext) systemContent += "\n\n--- Contexto de tu workspace (SOUL + memoria) ---\n" + workspaceContext;
		const onlyUserAssistant = incoming.filter((m) => m.role !== "system");
		const messages: import("./vllm.js").ChatMessage[] = [
			{ role: "system", content: systemContent },
			...onlyUserAssistant.map((m) => ({
				role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
				content: String(m.content),
			})),
		];
		const toolsDef = getToolsDefinition();
		try {
			setHealthActive();
			const content = await chatWithTools(messages, toolsDef, (name, args) => {
				const r = executeTool(name, args);
				return { ok: r.ok, content: r.ok ? r.content : r.error, error: r.ok ? undefined : r.error };
			});
			sendJson(res, 200, { content });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 502, { error: message });
		}
		return;
	}

	// GET / → index.html
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

server.listen(PORT, () => {
	console.log(`PiClaw web: http://127.0.0.1:${PORT}`);
	console.log(`vLLM: ${getVllmConfig().baseUrl} (model: ${getVllmConfig().model})`);
});
