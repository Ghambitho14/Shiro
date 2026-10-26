import { createServer } from "node:http";
import { isIP } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { getLastActive } from "./core/health/HealthManager.js";
import { getLLM } from "./core/llm/getLLM.js";
import { handleExtensionsApi } from "./extensionsApi.js";
import { handlePanelsApi } from "./panelsApi.js";
import { handleStorageApi } from "./storageApi.js";
import { handleProjectsApi } from "./projectsApi.js";
import { handlePromptsApi } from "./promptsApi.js";
import { handleLlamaCppApi } from "./llamacppApi.js";
import { handleModelSettingsApi } from "./modelSettingsApi.js";
import { handleAgentsApi } from "./agentsApi.js";
import { handleSettingsApi } from "./settingsApi.js";
import { handleVoiceApi } from "./voiceApi.js";
import { handleConnectionsApi } from "./connectionsApi.js";
import { handleChatApi } from "./chatApi.js";
import { handleRemindersApi, startReminderNotifications } from "./remindersApi.js";
import { releaseLlamaServer } from "./core/llamacpp/engine.js";
import { shiroBrowser } from "./core/browser/browser.js";
import { mcpManager } from "./core/mcp/McpManager.js";
import { stopWhatsAppBridge } from "./whatsapp.js";
import { autoStartTelegram } from "./telegram.js";
import { readAppFile, VENDOR_FILES } from "./runtime.js";
import { FETCH_USER_AGENT } from "./core/tools/modules/fetch.js";
import { readJson, safeDecode, send, sendJson } from "./http.js";

const PORT = Number(process.env.PORT) || 1406;
/** Por defecto solo localhost; usar BIND_HOST=0.0.0.0 para exponer. */
const BIND_HOST = process.env.BIND_HOST?.trim() || "127.0.0.1";
const IS_LOCAL_ONLY = BIND_HOST === "127.0.0.1" || BIND_HOST === "localhost" || BIND_HOST === "::1";
/** SHIRO_AUTH_TOKEN=off: sin contraseña aunque esté abierto a la red (p. ej. escuchando solo en Tailscale). */
const AUTH_DISABLED = /^(off|none|no)$/i.test(process.env.SHIRO_AUTH_TOKEN?.trim() ?? "");
/**
 * Las rutas sensibles exigen Authorization: Bearer <token> si hay token.
 * Si el servidor se abre a la red sin token, se genera uno aleatorio (salvo SHIRO_AUTH_TOKEN=off).
 */
const AUTH_TOKEN = AUTH_DISABLED
	? undefined
	: process.env.SHIRO_AUTH_TOKEN?.trim() || (IS_LOCAL_ONLY ? undefined : randomBytes(18).toString("base64url"));

let shuttingDown = false;

/**
 * Toda la API pide la contraseña (si hay una) salvo /api/health: así una ruta nueva nunca queda abierta por olvido.
 * /api/local/shutdown tiene su propia clave y se atiende antes.
 */
function isSensitivePath(pathname: string): boolean {
	return pathname.startsWith("/api/") && pathname !== "/api/health";
}

/** true si la petición no viene de otra página web (sin Origin, o Origin igual al Host). */
function isSameOrigin(req: import("node:http").IncomingMessage): boolean {
	// En modo local, el Host debe ser localhost (protege contra "DNS rebinding").
	const hostname = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
	if (IS_LOCAL_ONLY) {
		// Detrás de `tailscale serve` (HTTPS de Tailscale) llega el nombre del equipo: <equipo>.<tailnet>.ts.net.
		if (!["localhost", "127.0.0.1", "::1"].includes(hostname) && !hostname.endsWith(".ts.net")) return false;
	} else if (!AUTH_TOKEN) {
		// Abierto a la red sin contraseña: solo IPs, nombres sin punto (akuserver) o de Tailscale (*.ts.net),
		// que una web ajena no puede hacer apuntar a este servidor.
		if (!(isIP(hostname) || !hostname.includes(".") || hostname.endsWith(".ts.net"))) return false;
	}
	const origin = req.headers.origin;
	if (!origin) return true; // curl, apps, navegación directa
	try {
		return new URL(origin).host === req.headers.host;
	} catch {
		return false;
	}
}

function requireAuth(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): boolean {
	if (!AUTH_TOKEN) return false;
	const auth = req.headers.authorization;
	const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
	const a = Buffer.from(token);
	const b = Buffer.from(AUTH_TOKEN);
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		sendJson(res, 401, { error: "Unauthorized" });
		return true;
	}
	return false;
}

/** Cuándo arrancó este proceso: `npm start` lo compara con los archivos de src/ para saber si está anticuado. */
const STARTED_AT = Date.now();
/**
 * Clave para que `npm start` pueda cerrar este Shiro si se quedó anticuado. Solo se guarda en
 * data/cache/server-<puerto>.json (en este PC): ninguna web puede conocerla.
 */
const LOCAL_TOKEN = randomBytes(24).toString("hex");
const SERVER_INFO_FILE = join(DATA_DIR, "cache", `server-${PORT}.json`);

function isLoopback(req: import("node:http").IncomingMessage): boolean {
	const ip = req.socket.remoteAddress ?? "";
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function hasLocalToken(req: import("node:http").IncomingMessage): boolean {
	const sent = req.headers["x-shiro-local"];
	const a = Buffer.from(typeof sent === "string" ? sent : "");
	const b = Buffer.from(LOCAL_TOKEN);
	return a.length === b.length && timingSafeEqual(a, b);
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const parsedUrl = new URL(url, "http://127.0.0.1");
	const pathname = parsedUrl.pathname;

	// Sin CORS: la web se sirve desde este mismo origen. Rechazar peticiones de otras páginas
	// evita que cualquier web abierta en el navegador use Shiro (y sus herramientas) a escondidas.
	if (pathname.startsWith("/api/") && !isSameOrigin(req)) {
		sendJson(res, 403, { error: "Origen no permitido" });
		return;
	}
	// La herramienta fetch_url del propio modelo no lee esta API (chats, claves de mcp.json…).
	if (pathname.startsWith("/api/") && req.headers["user-agent"] === FETCH_USER_AGENT) {
		sendJson(res, 403, { error: "No permitido" });
		return;
	}
	if (method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}
	// `npm start` pide cerrar este Shiro cuando hay una versión más nueva en disco.
	if (method === "POST" && pathname === "/api/local/shutdown") {
		if (!isLoopback(req) || !hasLocalToken(req)) {
			sendJson(res, 403, { error: "No permitido" });
			return;
		}
		sendJson(res, 200, { ok: true });
		setTimeout(() => {
			stopCronScheduler();
			shutdown("update");
		}, 50);
		return;
	}
	if (isSensitivePath(pathname) && requireAuth(req, res)) return;

	// Ajustes → Habilidades, Ajustes → Conectores MCP y la lista de comandos del chat.
	if (await handleExtensionsApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Paneles Navegador y Terminal.
	if (await handlePanelsApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Ajustes → Datos y paso "¿Dónde guardo tus cosas?" de la bienvenida.
	if (await handleStorageApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Proyectos: instrucciones, carpetas vinculadas y archivos subidos.
	if (await handleProjectsApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Ajustes → Personalización: instrucciones base, SOUL.md, TOOLS.md y MEMORY.md.
	if (await handlePromptsApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Ajustes → Modelo con "llama.cpp integrado": descarga, modelos GGUF y memoria de la GPU.
	if (await handleLlamaCppApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Ajustes → Modelo → "Ajustes de <modelo>" (propios de cada modelo o generales).
	if (await handleModelSettingsApi(req, res, method, pathname, { readJson, sendJson })) return;
	// Ajustes → Agentes y las salas con varios agentes.
	if (await handleAgentsApi(req, res, method, pathname, { readJson, sendJson })) return;

	// Ajustes generales, modelo y «Sobre ti».
	if (await handleSettingsApi(req, res, method, pathname)) return;
	// Voz (Whisper y TTS) y capturas de pantalla.
	if (await handleVoiceApi(req, res, method, pathname, parsedUrl)) return;
	// Conexiones: WhatsApp y Telegram.
	if (await handleConnectionsApi(req, res, method, pathname)) return;
	// Chats, el chat con el modelo y las aprobaciones.
	if (await handleChatApi(req, res, method, pathname)) return;
	// Recordatorios y sus avisos.
	if (await handleRemindersApi(req, res, method, pathname)) return;

	if (method === "GET" && pathname === "/api/health") {
		sendJson(res, 200, {
			lastActive: getLastActive(),
			status: "active",
			startedAt: STARTED_AT,
			pid: process.pid,
		});
		return;
	}

	if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
		const html = readAppFile("public/index.html");
		if (!html) {
			send(res, 404, "Not found");
			return;
		}
		res.writeHead(200, { 
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-cache, no-store, must-revalidate",
			"Pragma": "no-cache",
			"Expires": "0"
		});
		res.end(html);
		return;
	}

	// Librerías del navegador (markdown, resaltado de código): se sirven desde node_modules, sin internet.
	if (method === "GET" && pathname.startsWith("/vendor/")) {
		const rel = VENDOR_FILES[pathname.slice("/vendor/".length)];
		const file = rel ? readAppFile(rel) : null;
		if (rel && file) {
			const type = rel.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8";
			res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=86400" });
			res.end(file);
			return;
		}
		send(res, 404, "Not found");
		return;
	}

	// Serve static files from public/ (images, scripts, styles, etc.)
	if (method === "GET") {
		const safePath = safeDecode(pathname).replace(/^\/+/, "");
		// Prevent directory traversal
		if (safePath && !safePath.includes("..")) {
			const content = readAppFile(`public/${safePath}`);
			if (content) {
				const ext = safePath.split(".").pop()?.toLowerCase() || "";
				const contentTypes: Record<string, string> = {
					"html": "text/html; charset=utf-8",
					"js": "application/javascript; charset=utf-8",
					"css": "text/css; charset=utf-8",
					"png": "image/png",
					"jpg": "image/jpeg",
					"jpeg": "image/jpeg",
					"gif": "image/gif",
					"svg": "image/svg+xml",
					"json": "application/json; charset=utf-8",
					"webmanifest": "application/manifest+json; charset=utf-8",
					"webp": "image/webp",
					"mp3": "audio/mpeg",
					"ico": "image/x-icon",
					"map": "application/json; charset=utf-8",
					"woff": "font/woff",
					"woff2": "font/woff2",
					"ttf": "font/ttf",
					"eot": "application/vnd.ms-fontobject",
				};
				const contentType = contentTypes[ext] ?? "application/octet-stream";
				res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
				res.end(content);
				return;
			}
		}
	}

	send(res, 404, "Not found");
});

server.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EADDRINUSE") {
		console.error(`\n  El puerto ${PORT} ya está en uso. Cierra el otro proceso o usa otro puerto:`);
		console.error(`  Windows (PowerShell): $env:PORT=1407; npm run dev`);
		console.error(`  Linux/Mac: PORT=1407 npm run dev\n`);
	} else {
		console.error(err);
	}
	process.exitCode = 1;
});

function shutdown(signal: NodeJS.Signals | "update"): void {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(signal === "update" ? "\n  Hay una versión nueva de Shiro: cierro esta para abrir la actualizada..." : `\n  ${signal} recibido. Cerrando Shiro...`);
	forgetServerInfo();
	void mcpManager.closeAll();
	void shiroBrowser.close();
	releaseLlamaServer();
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


startReminderNotifications();

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

function forgetServerInfo(): void {
	try {
		const info = JSON.parse(readFileSync(SERVER_INFO_FILE, "utf-8")) as { pid?: number };
		if (info.pid === process.pid) rmSync(SERVER_INFO_FILE, { force: true });
	} catch {
		// no estaba
	}
}

let markReady: (url: string) => void = () => {};
/** Se resuelve con la URL local cuando el servidor ya escucha (lo usa `npm run app`). */
export const serverReady = new Promise<string>((resolve) => (markReady = resolve));

server.listen(PORT, BIND_HOST, () => {
	console.log(`Shiro web: http://${BIND_HOST}:${PORT}`);
	try {
		mkdirSync(dirname(SERVER_INFO_FILE), { recursive: true });
		writeFileSync(SERVER_INFO_FILE, JSON.stringify({ pid: process.pid, port: PORT, token: LOCAL_TOKEN }), "utf-8");
	} catch {
		// sin este archivo, `npm start` solo avisará de que hay que cerrarlo a mano
	}
	markReady(`http://${IS_LOCAL_ONLY && BIND_HOST !== "::1" ? BIND_HOST.replace("localhost", "127.0.0.1") : "127.0.0.1"}:${PORT}`);
	const llm = getLLM().getConfig();
	console.log(`Modelo: ${llm.model} en ${llm.baseUrl} (${llm.provider})`);
	// Servidores MCP configurados en Ajustes → Conectores MCP (arrancan en segundo plano).
	mcpManager.start();
	// Telegram, si quedó conectado la última vez (Ajustes → Conexiones).
	autoStartTelegram();
	if (AUTH_TOKEN && !process.env.SHIRO_AUTH_TOKEN?.trim()) {
		console.log(`⚠️  El servidor está abierto a la red. Contraseña generada para esta sesión: ${AUTH_TOKEN}`);
		console.log("   (define SHIRO_AUTH_TOKEN para usar una fija)");
	} else if (AUTH_TOKEN) {
		console.log("Auth: token requerido en rutas sensibles (SHIRO_AUTH_TOKEN)");
	} else if (!IS_LOCAL_ONLY) {
		console.log(`⚠️  Sin contraseña (SHIRO_AUTH_TOKEN=off): quien llegue a ${BIND_HOST}:${PORT} puede usar Shiro.`);
	}
});
