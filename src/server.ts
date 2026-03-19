import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { getState } from "./store.js";
import { getUserProfile, setUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { getHealthState, setHealthActive } from "./core/health/HealthManager.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { createSessionMemoryStore } from "./core/memory/SessionMemoryStore.js";
import { runAgent } from "./core/agent/Agent.js";
import { getAllToolNames } from "./core/tools/ToolRegistry.js";
import { parseCommand } from "./commands.js";
import {
	createChatSession,
	deleteChatSession,
	getChatSession,
	listChatSessions,
	saveChatSession,
	sanitizeMessages,
	type ChatMessage,
} from "./chat/ChatStore.js";
import { getMessagePreview } from "./core/agent/contentUtils.js";
import { getWhatsAppBridgeStatus, startWhatsAppBridge, stopWhatsAppBridge } from "./whatsapp.js";
import { startHeartbeat, setNotificationCallback } from "./core/reminders/notifications.js";
import { startGateway, stopGateway, getGateway } from "./gateway.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 1406;
/** 6 MB para permitir imágenes en base64 en el chat (vision). */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
/** Por defecto solo localhost; usar BIND_HOST=0.0.0.0 para exponer. */
const BIND_HOST = process.env.BIND_HOST?.trim() || "127.0.0.1";
/** Si se define, las rutas sensibles exigen Authorization: Bearer <token>. */
const AUTH_TOKEN = process.env.SHIRO_AUTH_TOKEN?.trim();

const sessionMemoryStore = createSessionMemoryStore();
let shuttingDown = false;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		req.on("data", (chunk) => {
			const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			totalBytes += piece.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("BODY_TOO_LARGE"));
				return;
			}
			chunks.push(piece);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function isBodyTooLargeError(err: unknown): boolean {
	return err instanceof Error && err.message === "BODY_TOO_LARGE";
}

function send(res: import("node:http").ServerResponse, status: number, body: string, contentType = "text/plain"): void {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: object): void {
	send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

function isSensitivePath(pathname: string): boolean {
	return (
		pathname === "/api/chat" ||
		pathname.startsWith("/api/whatsapp/") ||
		pathname === "/api/user-profile" ||
		pathname === "/api/chat-sessions" ||
		pathname === "/api/reminders" ||
		pathname.startsWith("/api/chat-sessions/") ||
		pathname.startsWith("/api/reminders/")
	);
}

function requireAuth(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): boolean {
	if (!AUTH_TOKEN) return false;
	const auth = req.headers.authorization;
	const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	if (token !== AUTH_TOKEN) {
		sendJson(res, 401, { error: "Unauthorized" });
		return true;
	}
	return false;
}

function sanitizeAllowedTools(input: unknown): string[] | undefined {
	if (!Array.isArray(input)) return getAllToolNames();
	const all = new Set(getAllToolNames());
	const unique: string[] = [];
	for (const item of input) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (!name || !all.has(name) || unique.includes(name)) continue;
		unique.push(name);
	}
	return unique.length > 0 ? unique : getAllToolNames();
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
	if (isSensitivePath(pathname) && requireAuth(req, res)) return;

	if (method === "GET" && pathname === "/api/state") {
		const state = getState();
		const vllm = getLLM().getConfig();
		const config = getConfig();
		sendJson(res, 200, {
			name: state.name,
			vllm,
			abilities: config.abilities ?? null,
			autonomousMode: config.autonomousMode ?? true,
		});
		return;
	}

	if (method === "GET" && pathname === "/api/notifications") {
		const notifs = pendingNotifications.splice(0, 10);
		sendJson(res, 200, { notifications: notifs });
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
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return;
			}
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
			} catch (err) {
				if (isBodyTooLargeError(err)) {
					sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
					return;
				}
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
			sessionMemoryStore.delete(sessionId);
			sendJson(res, 200, { ok: true });
			return;
		}
	}

	if (method === "POST" && pathname === "/api/chat") {
		let body: string;
		try {
			body = await readBody(req);
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return;
			}
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let incoming: ChatMessage[];
		let allowedTools: string[] | undefined;
		let sessionId: string | undefined;
		try {
			const parsed = JSON.parse(body) as {
				messages?: Array<{ role?: string; content?: string }>;
				allowedTools?: unknown;
				sessionId?: unknown;
			};
			incoming = sanitizeMessages(parsed.messages);
			allowedTools = sanitizeAllowedTools(parsed.allowedTools);
			console.log("🛠️ Tools sanitized:", allowedTools?.length || "todas");
			sessionId = typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined;
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
		const lastMessage = incoming[incoming.length - 1];
		const userContent = getMessagePreview(lastMessage?.content ?? "");
		const hasContent = userContent.length > 0 || (Array.isArray(lastMessage?.content) && lastMessage.content.some((p: { type: string }) => p.type === "image_url"));
		if (!hasContent) {
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
			const config = getConfig();
			const autonomous = config.autonomousMode !== false;
			const goal = userContent.trim() || "¿Qué hay en esta imagen?";
			
			// Procesar comandos
			const commandResult = parseCommand(goal, sessionId ?? "web-default");
			if (commandResult?.executed) {
				console.log(`📝 Comando /${goal.slice(1).split(/\s/)[0]} ejecutado`);
				sendJson(res, 200, { content: commandResult.content });
				return;
			}
			
			console.log("🛠️ Tools:", allowedTools?.length || "todas (15)", "| Autonomous:", autonomous, "| Msg:", goal.slice(0, 30));
			const content = await runAgent(goal, {
				llm: getLLM(),
				memory: sessionMemoryStore.getMemory(sessionId ?? "web-default"),
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: autonomous,
				textOnly: !autonomous,
				allowedTools,
				conversation: incoming,
				userProfile: getUserProfile(),
			}, workspaceContext ?? undefined);
			sendJson(res, 200, { content });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			sendJson(res, 502, { error: message });
		}
		return;
	}

	if (method === "GET" && pathname === "/api/user-profile") {
		sendJson(res, 200, getUserProfile());
		return;
	}

	if (method === "PUT" && pathname === "/api/user-profile") {
		let body = "";
		try {
			body = await readBody(req);
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return;
			}
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		const next = setUserProfile({
			userName: typeof payload.userName === "string" ? payload.userName : undefined,
			language: typeof payload.language === "string" ? payload.language : undefined,
			about: typeof payload.about === "string" ? payload.about : undefined,
			extra: typeof payload.extra === "string" ? payload.extra : undefined,
		});
		sendJson(res, 200, next);
		return;
	}

	// === REMINDERS API ===
	if (method === "GET" && pathname === "/api/reminders") {
		const { getReminders } = await import("./core/reminders/reminders.js");
		sendJson(res, 200, { reminders: getReminders() });
		return;
	}

	if (method === "POST" && pathname === "/api/reminders") {
		let body = "";
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		const { createReminder } = await import("./core/reminders/reminders.js");
		try {
			const reminder = createReminder({
				title: String(payload.title || ""),
				datetime: String(payload.datetime || ""),
				description: payload.description ? String(payload.description) : undefined,
				repeat: payload.repeat ? String(payload.repeat) as "daily" | "weekly" | "monthly" | "none" : "none",
			});
			sendJson(res, 201, { reminder });
		} catch (err) {
			sendJson(res, 500, { error: err instanceof Error ? err.message : "Error creating reminder" });
		}
		return;
	}

	if (method === "POST" && pathname.startsWith("/api/reminders/")) {
		const id = pathname.slice("/api/reminders/".length);
		let body = "";
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		if (payload.action === "complete") {
			const { completeReminder } = await import("./core/reminders/reminders.js");
			const result = completeReminder(id);
			if (result) {
				sendJson(res, 200, { success: true, reminder: result });
			} else {
				sendJson(res, 404, { error: "Reminder not found" });
			}
			return;
		}
		if (payload.action === "delete") {
			const { deleteReminder } = await import("./core/reminders/reminders.js");
			const result = deleteReminder(id);
			sendJson(res, 200, { success: result });
			return;
		}
		sendJson(res, 400, { error: "Invalid action" });
		return;
	}

	if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
		const path = join(PUBLIC_DIR, "index.html");
		if (!existsSync(path)) {
			send(res, 404, "Not found");
			return;
		}
		res.writeHead(200, { 
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			"Pragma": "no-cache",
			"Expires": "0"
		});
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
	stopGateway();
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

const pendingNotifications: Array<{ id: string; title: string; description?: string; datetime: string; createdAt: string }> = [];

setNotificationCallback((reminder) => {
	pendingNotifications.unshift({
		id: reminder.id,
		title: reminder.title,
		description: reminder.description,
		datetime: reminder.datetime,
		createdAt: reminder.createdAt,
	});
	if (pendingNotifications.length > 50) {
		pendingNotifications.length = 50;
	}
});

startHeartbeat();

// Inicializar scheduler de tareas programadas
import { initCronScheduler, stopCronScheduler } from "./core/scheduler/CronService.js";
initCronScheduler();

process.on("SIGINT", () => {
	stopCronScheduler();
	shutdown("SIGINT");
});
process.on("SIGTERM", () => {
	stopCronScheduler();
	shutdown("SIGTERM");
});

server.listen(PORT, BIND_HOST, () => {
	console.log(`Shiro web: http://${BIND_HOST}:${PORT}`);
	console.log(`vLLM: ${getLLM().getConfig().baseUrl} (model: ${getLLM().getConfig().model})`);
	if (AUTH_TOKEN) console.log("Auth: token requerido en rutas sensibles (SHIRO_AUTH_TOKEN)");
	
	// Iniciar Gateway WebSocket (compartiendo servidor)
	const gw = getGateway();
	gw.startWithServer(server, "/ws");
});
