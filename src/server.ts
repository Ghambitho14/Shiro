import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { getState } from "./store.js";
import { getConfig } from "./config/config.js";
import { getHealthState, setHealthActive } from "./core/health/HealthManager.js";
import { buildWorkspaceContext } from "./workspace.js";
import { vllmClient } from "./core/llm/vllmClient.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import {
	createChatSession,
	deleteChatSession,
	getChatSession,
	listChatSessions,
	saveChatSession,
	type ChatMessage,
} from "./chat/ChatStore.js";
import { getWhatsAppBridgeStatus, startWhatsAppBridge, stopWhatsAppBridge } from "./whatsapp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 1406;

const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
let shuttingDown = false;

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

function sanitizeMessages(input: unknown): ChatMessage[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const role = (item as { role?: unknown }).role;
			const content = (item as { content?: unknown }).content;
			if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
			const trimmed = content.trim();
			if (!trimmed) return null;
			return { role, content: trimmed } as ChatMessage;
		})
		.filter((m): m is ChatMessage => m !== null);
}

function isWhatsAppConfigureIntent(text: string): boolean {
	const t = text.toLowerCase();
	return (t.includes("whatsapp") && (t.includes("config") || t.includes("conectar") || t.includes("iniciar")))
		|| t.includes("quiero configurar whatsapp")
		|| t.includes("activar whatsapp");
}

function isWhatsAppStopIntent(text: string): boolean {
	const t = text.toLowerCase();
	return t.includes("detener whatsapp") || t.includes("apagar whatsapp") || t.includes("desconectar whatsapp");
}

function isWhatsAppStatusIntent(text: string): boolean {
	const t = text.toLowerCase();
	return t.includes("estado whatsapp") || t.includes("status whatsapp") || t.includes("como va whatsapp");
}

async function buildWhatsAppResponse(): Promise<{ status: ReturnType<typeof getWhatsAppBridgeStatus>; qrDataUrl: string | null }> {
	const status = getWhatsAppBridgeStatus();
	const qrDataUrl = status.qr ? await QRCode.toDataURL(status.qr, { margin: 1, width: 280 }) : null;
	return { status, qrDataUrl };
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const parsedUrl = new URL(url, "http://127.0.0.1");
	const pathname = parsedUrl.pathname;

	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	if (method === "GET" && pathname === "/api/state") {
		const state = getState();
		const vllm = vllmClient.getConfig();
		const config = getConfig();
		sendJson(res, 200, { name: state.name, vllm, abilities: config.abilities ?? null });
		return;
	}

	if (method === "GET" && pathname === "/api/health") {
		const h = getHealthState();
		sendJson(res, 200, {
			lastActive: h.lastActive,
			status: h.status === "paused" ? "idle" : "active",
		});
		return;
	}

	if (method === "GET" && pathname === "/api/whatsapp/status") {
		const data = await buildWhatsAppResponse();
		sendJson(res, 200, data);
		return;
	}

	if (method === "POST" && pathname === "/api/whatsapp/start") {
		try {
			await startWhatsAppBridge({ printQrToConsole: true });
			const data = await buildWhatsAppResponse();
			sendJson(res, 200, data);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 502, { error: `No pude iniciar WhatsApp: ${message}` });
		}
		return;
	}

	if (method === "POST" && pathname === "/api/whatsapp/stop") {
		try {
			await stopWhatsAppBridge();
			const data = await buildWhatsAppResponse();
			sendJson(res, 200, data);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 502, { error: `No pude detener WhatsApp: ${message}` });
		}
		return;
	}

	if (method === "GET" && pathname === "/api/chat-sessions") {
		sendJson(res, 200, { sessions: listChatSessions() });
		return;
	}

	if (method === "POST" && pathname === "/api/chat-sessions") {
		let body = "";
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let initialMessages: ChatMessage[] = [];
		try {
			if (body.trim()) {
				const parsed = JSON.parse(body) as { messages?: unknown };
				initialMessages = sanitizeMessages(parsed.messages);
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		const session = createChatSession(initialMessages);
		sendJson(res, 201, { session });
		return;
	}

	if (pathname.startsWith("/api/chat-sessions/")) {
		const sessionId = decodeURIComponent(pathname.slice("/api/chat-sessions/".length)).trim();
		if (!sessionId) {
			sendJson(res, 400, { error: "session id required" });
			return;
		}

		if (method === "GET") {
			const session = getChatSession(sessionId);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sendJson(res, 200, { session });
			return;
		}

		if (method === "PUT") {
			let body = "";
			try {
				body = await readBody(req);
			} catch {
				sendJson(res, 400, { error: "Invalid body" });
				return;
			}
			let messages: ChatMessage[] = [];
			try {
				const parsed = JSON.parse(body) as { messages?: unknown };
				messages = sanitizeMessages(parsed.messages);
			} catch {
				sendJson(res, 400, { error: "Invalid JSON" });
				return;
			}
			const session = saveChatSession(sessionId, messages);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sendJson(res, 200, { session });
			return;
		}

		if (method === "DELETE") {
			const ok = deleteChatSession(sessionId);
			if (!ok) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sendJson(res, 200, { ok: true });
			return;
		}
	}

	if (method === "POST" && pathname === "/api/chat") {
		let body: string;
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let incoming: ChatMessage[];
		try {
			const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: string }> };
			incoming = sanitizeMessages(parsed.messages);
			if (!incoming.length) {
				sendJson(res, 400, { error: "messages array required" });
				return;
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		const state = getState();
		const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
		const userContent = incoming[incoming.length - 1]?.content ?? "";
		if (!userContent.trim()) {
			sendJson(res, 400, { error: "Empty message" });
			return;
		}
		if (isWhatsAppConfigureIntent(userContent)) {
			try {
				await startWhatsAppBridge({ printQrToConsole: true });
				const data = await buildWhatsAppResponse();
				const base = data.status.state === "ready"
					? "WhatsApp ya está conectado."
					: "Listo. Inicié la configuración de WhatsApp.";
				const content = data.qrDataUrl
					? `${base} Escanea el código QR que te muestro abajo desde WhatsApp > Dispositivos vinculados.`
					: `${base} Esperando QR... si no aparece en unos segundos, vuelve a pedir: "configurar whatsapp".`;
				sendJson(res, 200, { content, whatsapp: { ...data.status, qrDataUrl: data.qrDataUrl } });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				sendJson(res, 502, { error: `No pude iniciar WhatsApp: ${message}` });
			}
			return;
		}
		if (isWhatsAppStopIntent(userContent)) {
			try {
				await stopWhatsAppBridge();
				const data = await buildWhatsAppResponse();
				sendJson(res, 200, {
					content: "He detenido el puente de WhatsApp. Si quieres volver a conectarlo, dime: configurar whatsapp.",
					whatsapp: { ...data.status, qrDataUrl: data.qrDataUrl },
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				sendJson(res, 502, { error: `No pude detener WhatsApp: ${message}` });
			}
			return;
		}
		if (isWhatsAppStatusIntent(userContent)) {
			const data = await buildWhatsAppResponse();
			const content = data.status.state === "ready"
				? "WhatsApp está conectado."
				: data.qrDataUrl
					? "WhatsApp está esperando QR. Te lo muestro abajo."
					: `WhatsApp está en estado: ${data.status.state}.`;
			sendJson(res, 200, { content, whatsapp: { ...data.status, qrDataUrl: data.qrDataUrl } });
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

	if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
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

function shutdown(signal: NodeJS.Signals): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\n  ${signal} recibido. Cerrando Shiro...`);
	server.close((err) => {
		if (err) {
			console.error("  Error al cerrar el servidor:", err);
			process.exit(1);
			return;
		}
		void stopWhatsAppBridge().catch(() => {});
		console.log("  Servidor cerrado. Hasta luego.\n");
		process.exit(0);
	});
	setTimeout(() => {
		console.error("  Cierre forzado por timeout.");
		process.exit(1);
	}, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, () => {
	console.log(`Shiro web: http://127.0.0.1:${PORT}`);
	console.log(`vLLM: ${vllmClient.getConfig().baseUrl} (model: ${vllmClient.getConfig().model})`);
});
