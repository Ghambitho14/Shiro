import { createServer } from "node:http";
import { isIP } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname, basename, resolve as resolvePath, sep } from "node:path";
import QRCode from "qrcode";
import { getState, setState } from "./store.js";
import { getUserProfile, setUserProfile } from "./user-profile.js";
import { getConfig, setConfig, LLM_PROVIDERS, DATA_DIR, type LLMProvider } from "./config/config.js";
import { PROVIDER_PRESETS, modelSupportsVision, resolveLLMSettings } from "./core/llm/providers.js";
import { listProviderModels } from "./core/llm/modelList.js";
import { canRememberApproval, type Approver } from "./core/tools/approval.js";
import { SCREENSHOT_DIR } from "./core/pc/pc.js";
import { getLastActive, setHealthActive } from "./core/health/HealthManager.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { runAgent } from "./core/agent/Agent.js";
import { getAllToolNames } from "./core/tools/ToolRegistry.js";
import { matchSkillCommand, parseCommand } from "./commands.js";
import { handleExtensionsApi } from "./extensionsApi.js";
import { handlePanelsApi } from "./panelsApi.js";
import { handleStorageApi } from "./storageApi.js";
import { handleProjectsApi } from "./projectsApi.js";
import { handlePromptsApi } from "./promptsApi.js";
import { handleLlamaCppApi } from "./llamacppApi.js";
import { handleModelSettingsApi } from "./modelSettingsApi.js";
import { handleAgentsApi } from "./agentsApi.js";
import { deleteRoom, getRoom, isValidSessionId, saveRoom } from "./core/rooms/roomStore.js";
import { currentAgents, planRoomTurn, prepareAgentTurn, publicAgent, publicRoom, type AgentTurn, type RoomPlan } from "./core/rooms/roomTurn.js";
import { releaseLlamaServer } from "./core/llamacpp/engine.js";
import { attachChat, forgetChat, getProject, projectOfChat, touchProject } from "./core/projects/projects.js";
import { shiroBrowser } from "./core/browser/browser.js";
import { mcpManager } from "./core/mcp/McpManager.js";
import {
	createChatSession,
	deleteChatSession,
	getChatSession,
	listChatSessions,
	renameChatSession,
	saveChatSession,
	sanitizeMessages,
	type ChatMessage,
} from "./chat/ChatStore.js";
import { getMessagePreview } from "./core/agent/contentUtils.js";
import { getWhatsAppBridgeStatus, startWhatsAppBridge, stopWhatsAppBridge } from "./whatsapp.js";
import { allowTelegramChat, autoStartTelegram, connectTelegram, disconnectTelegram, getTelegramStatus, revokeTelegramChat } from "./telegram.js";
import { startHeartbeat, setNotificationCallback } from "./core/reminders/notifications.js";
import { readAppFile, VENDOR_FILES } from "./runtime.js";
import { FETCH_USER_AGENT } from "./core/tools/modules/fetch.js";

const PORT = Number(process.env.PORT) || 1406;
/** 6 MB para permitir imágenes en base64 en el chat (vision). */
const MAX_BODY_BYTES = 6 * 1024 * 1024;
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

/** Aprobaciones pendientes de acciones peligrosas, resueltas desde la web. */
type PendingApproval = { finish: (approved: boolean) => void; tool: string; sessionKey: string };
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
/** Herramientas que el usuario permitió "siempre en este chat" (solo en memoria: se olvidan al reiniciar). */
const sessionApprovals = new Map<string, Set<string>>();
/** Salas respondiendo ahora: un turno a la vez por sala. */
const roomTurns = new Set<string>();

/** Approver para una respuesta en streaming: pregunta al navegador por SSE y espera su respuesta. */
function createSseApprover(res: import("node:http").ServerResponse, sessionKey: string): Approver {
	return ({ tool, summary }) =>
		new Promise<boolean>((resolve) => {
			if (res.writableEnded) return resolve(false);
			if (sessionApprovals.get(sessionKey)?.has(tool)) return resolve(true);
			const id = randomBytes(8).toString("hex");
			const finish = (approved: boolean) => {
				clearTimeout(timer);
				res.off("close", onClose);
				pendingApprovals.delete(id);
				resolve(approved);
			};
			const onClose = () => finish(false);
			const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
			res.on("close", onClose);
			pendingApprovals.set(id, { finish, tool, sessionKey });
			sendSseData(res, { type: "approval", id, tool, summary, canRemember: canRememberApproval(tool) });
		});
}

/** Ajustes que ve la web. Nunca incluye API keys: solo si hay una guardada. */
function buildSettings() {
	const c = getConfig();
	const llm = getLLM().getConfig();
	return {
		assistantName: getState().name,
		/** Primera vez: la web muestra la bienvenida (quién eres, nombre, dónde guardar, modelo). */
		needsSetup: !c.setupDone && !getUserProfile().userName,
		storage: c.storage,
		autonomousMode: c.autonomousMode,
		approvalMode: c.approvalMode,
		execAllowlist: c.execAllowlist,
		pcControl: c.pcControl,
		vision: c.vision,
		visionActive: modelSupportsVision(llm.model, c.vision),
		platform: process.platform,
		voice: {
			sttEngine: c.sttEngine,
			sttBaseUrl: c.sttBaseUrl ?? "",
			sttModel: c.sttModel,
			hasSttApiKey: Boolean(c.sttApiKey),
			ttsEngine: c.ttsEngine,
			ttsBaseUrl: c.ttsBaseUrl ?? "",
			ttsModel: c.ttsModel,
			ttsVoice: c.ttsVoice,
			hasTtsApiKey: Boolean(c.ttsApiKey),
		},
	};
}

/**
 * Aplica los cambios de la web. Las API keys: texto = nueva clave, "" = mantener, null = borrar.
 * Los valores inválidos los descarta el schema de configuración.
 */
function applySettings(d: Record<string, unknown>): void {
	const patch: Record<string, unknown> = {};
	const copy = (keys: string[]) => {
		for (const k of keys) if (k in d && d[k] !== undefined) patch[k] = d[k];
	};
	copy(["autonomousMode", "approvalMode", "pcControl", "vision", "sttEngine", "sttModel", "ttsEngine", "ttsModel", "ttsVoice"]);
	for (const k of ["sttBaseUrl", "ttsBaseUrl"]) {
		if (typeof d[k] === "string") patch[k] = (d[k] as string).trim() || undefined;
	}
	for (const k of ["sttApiKey", "ttsApiKey"]) {
		if (d[k] === null) patch[k] = undefined;
		else if (typeof d[k] === "string" && (d[k] as string).trim()) patch[k] = (d[k] as string).trim();
	}
	if (Array.isArray(d.execAllowlist)) {
		patch.execAllowlist = d.execAllowlist.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
	}
	if (typeof d.setupDone === "boolean") patch.setupDone = d.setupDone;
	if (Object.keys(patch).length) setConfig(patch as Partial<ReturnType<typeof getConfig>>);
	if (typeof d.assistantName === "string" && d.assistantName.trim()) setState({ name: d.assistantName.trim().slice(0, 40) });
}

/** URL pública de una captura de pantalla (solo si está en la carpeta de capturas). */
function screenshotUrl(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const full = resolvePath(path);
	if (!full.startsWith(resolvePath(SCREENSHOT_DIR) + sep)) return undefined;
	return "/api/screenshots/" + encodeURIComponent(basename(full));
}

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

/** decodeURIComponent que no lanza con URLs mal formadas (devuelve "" y la ruta da 404). */
function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return "";
	}
}

/** Cuerpo binario (audio para transcribir). */
function readBodyBuffer(req: import("node:http").IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > maxBytes) {
				req.destroy();
				reject(new Error("BODY_TOO_LARGE"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function readJson<T>(req: import("node:http").IncomingMessage): Promise<T> {
	const body = await readBody(req);
	return (body.trim() ? JSON.parse(body) : {}) as T;
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

function sendSseData(res: import("node:http").ServerResponse, payload: Record<string, unknown>): void {
	if (res.writableEnded) return;
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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

async function buildWhatsAppResponse(): Promise<{ status: ReturnType<typeof getWhatsAppBridgeStatus>; qrDataUrl: string | null }> {
	const status = getWhatsAppBridgeStatus();
	const qrDataUrl = status.qr ? await QRCode.toDataURL(status.qr, { margin: 1, width: 280 }) : null;
	return { status, qrDataUrl };
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

	if (method === "GET" && pathname === "/api/state") {
		const state = getState();
		const vllm = getLLM().getConfig();
		const config = getConfig();
		const waStatus = getWhatsAppBridgeStatus();
		const waQr = waStatus.qr ? await (await import("qrcode")).toDataURL(waStatus.qr, { margin: 1, width: 280 }) : null;
		sendJson(res, 200, {
			name: state.name,
			vllm,
			abilities: config.abilities ?? null,
			autonomousMode: config.autonomousMode ?? true,
			whatsapp: { ...waStatus, qrDataUrl: waQr },
		});
		return;
	}

	if (method === "GET" && pathname === "/api/llm-config") {
		const s = resolveLLMSettings();
		sendJson(res, 200, {
			provider: s.provider,
			model: s.model,
			baseUrl: s.baseUrl,
			hasApiKey: Boolean(s.apiKey),
			providers: LLM_PROVIDERS.map((p) => ({
				value: p,
				label: PROVIDER_PRESETS[p].label,
				title: PROVIDER_PRESETS[p].title,
				hint: PROVIDER_PRESETS[p].hint,
				group: PROVIDER_PRESETS[p].group,
				baseUrl: PROVIDER_PRESETS[p].baseUrl,
				model: PROVIDER_PRESETS[p].model,
				local: PROVIDER_PRESETS[p].local,
				needsApiKey: PROVIDER_PRESETS[p].needsApiKey,
				keyUrl: PROVIDER_PRESETS[p].keyUrl ?? "",
				managed: Boolean(PROVIDER_PRESETS[p].managed),
			})),
		});
		return;
	}

	if (method === "PUT" && pathname === "/api/llm-config") {
		let data: { provider?: string; model?: string; baseUrl?: string; apiKey?: string };
		try {
			data = JSON.parse(await readBody(req));
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		if (!data.provider || !(LLM_PROVIDERS as readonly string[]).includes(data.provider)) {
			sendJson(res, 400, { error: "Proveedor inválido" });
			return;
		}
		const provider = data.provider as LLMProvider;
		const preset = PROVIDER_PRESETS[provider];
		const baseUrl = data.baseUrl?.trim();
		const model = data.model?.trim();
		setConfig({
			llmProvider: provider,
			// llama.cpp integrado: la dirección la pone Shiro al abrirlo.
			llmBaseUrl: !preset.managed && baseUrl && baseUrl !== preset.baseUrl ? baseUrl : undefined,
			llmModel: model && model !== preset.model ? model : undefined,
			// Vacío = mantener la key actual (el navegador nunca la recibe), salvo al cambiar de proveedor.
			...(data.apiKey?.trim()
				? { llmApiKey: data.apiKey.trim() }
				: provider !== getConfig().llmProvider
					? { llmApiKey: undefined }
					: {}),
		});
		sendJson(res, 200, { ok: true });
		return;
	}

	if (method === "POST" && pathname === "/api/llm-test") {
		try {
			const t0 = Date.now();
			const reply = await getLLM().chat([{ role: "user", content: "Responde solo: ok" }]);
			sendJson(res, 200, { ok: true, reply: reply.slice(0, 200), ms: Date.now() - t0 });
		} catch (err) {
			sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
		}
		return;
	}

	// === AJUSTES (lo que se cambia desde la ventana de Ajustes de la web) ===
	if (method === "GET" && pathname === "/api/settings") {
		sendJson(res, 200, buildSettings());
		return;
	}

	if (method === "PUT" && pathname === "/api/settings") {
		let data: Record<string, unknown>;
		try {
			data = await readJson<Record<string, unknown>>(req);
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		try {
			applySettings(data);
			sendJson(res, 200, buildSettings());
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return;
	}

	// === MODELOS DISPONIBLES en el proveedor actual (para el selector rápido) ===
	if (method === "GET" && pathname === "/api/models") {
		const s = resolveLLMSettings();
		const list = await listProviderModels({ provider: s.provider });
		sendJson(res, 200, {
			provider: s.provider,
			current: s.model,
			models: list.models.map((m) => m.id),
			...(list.error ? { error: `No pude pedir la lista de modelos: ${list.error}` } : {}),
		});
		return;
	}

	// === MODELOS de un proveedor del formulario de Ajustes → Modelo (aún sin guardar) ===
	if (method === "POST" && pathname === "/api/models") {
		let data: { provider?: string; baseUrl?: string; apiKey?: string };
		try {
			data = await readJson<typeof data>(req);
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		if (!data.provider || !(LLM_PROVIDERS as readonly string[]).includes(data.provider)) {
			sendJson(res, 400, { error: "Proveedor inválido" });
			return;
		}
		sendJson(
			res,
			200,
			await listProviderModels({
				provider: data.provider as LLMProvider,
				baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : undefined,
				apiKey: typeof data.apiKey === "string" ? data.apiKey : undefined,
			}),
		);
		return;
	}

	// === VOZ: transcribir (Whisper) y leer en voz alta (TTS) con un servidor compatible con OpenAI ===
	if (method === "POST" && pathname === "/api/voice/transcribe") {
		const cfg = getConfig();
		if (!cfg.sttBaseUrl) {
			sendJson(res, 400, { error: "Configura el servidor de reconocimiento de voz en Ajustes → Voz." });
			return;
		}
		let audio: Buffer;
		try {
			audio = await readBodyBuffer(req, 25 * 1024 * 1024);
		} catch {
			sendJson(res, 413, { error: "Audio demasiado largo (máx. 25 MB)." });
			return;
		}
		if (audio.byteLength < 200) {
			sendJson(res, 200, { text: "" });
			return;
		}
		const mime = String(req.headers["content-type"] || "audio/webm").split(";")[0];
		const ext = mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : mime.includes("mp4") ? "mp4" : mime.includes("mpeg") ? "mp3" : "webm";
		const form = new FormData();
		form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
		form.append("model", cfg.sttModel);
		const lang = (parsedUrl.searchParams.get("lang") || "es").slice(0, 2).toLowerCase();
		if (/^[a-z]{2}$/.test(lang)) form.append("language", lang);
		form.append("response_format", "json");
		try {
			const r = await fetch(`${cfg.sttBaseUrl}/audio/transcriptions`, {
				method: "POST",
				headers: cfg.sttApiKey ? { Authorization: `Bearer ${cfg.sttApiKey}` } : {},
				body: form,
				signal: AbortSignal.timeout(90_000),
			});
			if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
			const j = (await r.json()) as { text?: string };
			sendJson(res, 200, { text: (j.text ?? "").trim() });
		} catch (err) {
			sendJson(res, 502, { error: `El servidor de voz (${cfg.sttBaseUrl}) falló: ${err instanceof Error ? err.message : String(err)}` });
		}
		return;
	}

	if (method === "POST" && pathname === "/api/voice/speak") {
		const cfg = getConfig();
		if (!cfg.ttsBaseUrl) {
			sendJson(res, 400, { error: "Configura el servidor de voz (TTS) en Ajustes → Voz." });
			return;
		}
		let text = "";
		let speed: number | undefined;
		let voiceName = cfg.ttsVoice;
		try {
			const body = await readJson<{ text?: unknown; speed?: unknown; voice?: unknown }>(req);
			text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
			speed = typeof body.speed === "number" && body.speed >= 0.5 && body.speed <= 2 ? body.speed : undefined;
			// La voz de un agente de la sala (si no, la de Ajustes → Voz).
			if (typeof body.voice === "string" && /^[\w.-]{1,40}$/.test(body.voice)) voiceName = body.voice;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		if (!text) {
			sendJson(res, 400, { error: "Texto vacío" });
			return;
		}
		try {
			const r = await fetch(`${cfg.ttsBaseUrl}/audio/speech`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(cfg.ttsApiKey ? { Authorization: `Bearer ${cfg.ttsApiKey}` } : {}) },
				body: JSON.stringify({ model: cfg.ttsModel, voice: voiceName, input: text, response_format: "mp3", ...(speed ? { speed } : {}) }),
				signal: AbortSignal.timeout(60_000),
			});
			if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
			const audio = Buffer.from(await r.arrayBuffer());
			res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "audio/mpeg", "Cache-Control": "no-store" });
			res.end(audio);
		} catch (err) {
			sendJson(res, 502, { error: `El servidor de voz (${cfg.ttsBaseUrl}) falló: ${err instanceof Error ? err.message : String(err)}` });
		}
		return;
	}

	// === CAPTURAS DE PANTALLA hechas por pc_screenshot ===
	if (method === "GET" && pathname.startsWith("/api/screenshots/")) {
		const name = safeDecode(pathname.slice("/api/screenshots/".length));
		const file = join(SCREENSHOT_DIR, name);
		if (!/^[\w.-]+\.jpg$/.test(name) || !existsSync(file)) {
			send(res, 404, "Not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
		res.end(readFileSync(file));
		return;
	}

	if (method === "POST" && pathname.startsWith("/api/approvals/")) {
		const id = pathname.slice("/api/approvals/".length);
		const pending = pendingApprovals.get(id);
		if (!pending) {
			sendJson(res, 404, { error: "Aprobación no encontrada o expirada" });
			return;
		}
		let approved = false;
		let remember = false;
		try {
			const body = JSON.parse(await readBody(req)) as { approved?: unknown; remember?: unknown };
			approved = body.approved === true;
			remember = body.remember === true;
		} catch {
			/* cuerpo inválido = rechazar */
		}
		if (approved && remember && canRememberApproval(pending.tool)) {
			const set = sessionApprovals.get(pending.sessionKey) ?? new Set<string>();
			set.add(pending.tool);
			sessionApprovals.set(pending.sessionKey, set);
		}
		pending.finish(approved);
		sendJson(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/notifications") {
		const notifs = pendingNotifications.splice(0, 10);
		sendJson(res, 200, { notifications: notifs });
		return;
	}

	if (method === "GET" && pathname === "/api/health") {
		sendJson(res, 200, {
			lastActive: getLastActive(),
			status: "active",
			startedAt: STARTED_AT,
			pid: process.pid,
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

	// === TELEGRAM (el token nunca vuelve al navegador) ===
	if (method === "GET" && pathname === "/api/telegram/status") {
		sendJson(res, 200, getTelegramStatus());
		return;
	}

	if (method === "POST" && pathname.startsWith("/api/telegram/")) {
		let data: { token?: unknown; chatId?: unknown };
		try {
			data = JSON.parse((await readBody(req)) || "{}");
		} catch {
			sendJson(res, 400, { error: "JSON inválido" });
			return;
		}
		const chatId = typeof data.chatId === "string" && /^-?\d+$/.test(data.chatId) ? data.chatId : "";
		try {
			if (pathname === "/api/telegram/start") await connectTelegram(typeof data.token === "string" ? data.token : undefined);
			else if (pathname === "/api/telegram/stop") disconnectTelegram();
			else if (pathname === "/api/telegram/allow" && chatId) await allowTelegramChat(chatId);
			else if (pathname === "/api/telegram/revoke" && chatId) revokeTelegramChat(chatId);
			else {
				sendJson(res, 404, { error: "No encontrado" });
				return;
			}
			sendJson(res, 200, getTelegramStatus());
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return;
	}

	if (method === "GET" && pathname === "/api/chat-sessions") {
		const sessions = await listChatSessions();
		sendJson(res, 200, { sessions });
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
		let projectId = "";
		try {
			if (body.trim()) {
				const parsed = JSON.parse(body) as { messages?: unknown; projectId?: unknown };
				initialMessages = sanitizeMessages(parsed.messages);
				projectId = typeof parsed.projectId === "string" ? parsed.projectId : "";
			}
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return;
		}
		if (projectId && !getProject(projectId)) {
			sendJson(res, 404, { error: "No encontré el proyecto." });
			return;
		}
		const session = await createChatSession(initialMessages);
		// Chat nuevo dentro de un proyecto (desde la página del proyecto).
		if (projectId) attachChat(projectId, session.id);
		sendJson(res, 201, { session });
		return;
	}

	if (pathname.startsWith("/api/chat-sessions/")) {
		const sessionId = safeDecode(pathname.slice("/api/chat-sessions/".length)).trim();
		if (!sessionId) {
			sendJson(res, 400, { error: "session id required" });
			return;
		}

		if (method === "GET") {
			const session = await getChatSession(sessionId);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sendJson(res, 200, { session });
			return;
		}

		if (method === "PATCH") {
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
			let title: string | undefined;
			try {
				if (body.trim()) {
					const parsed = JSON.parse(body) as { title?: unknown };
					title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;
				}
			} catch {
				sendJson(res, 400, { error: "Invalid JSON" });
				return;
			}
			if (!title) {
				sendJson(res, 400, { error: "title required" });
				return;
			}
			const session = await renameChatSession(sessionId, title);
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
			const session = await saveChatSession(sessionId, messages);
			if (!session) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sendJson(res, 200, { session });
			return;
		}

		if (method === "DELETE") {
			const ok = await deleteChatSession(sessionId);
			if (!ok) {
				sendJson(res, 404, { error: "Session not found" });
				return;
			}
			sessionApprovals.delete(sessionId);
			forgetChat(sessionId);
			deleteRoom(sessionId);
			sendJson(res, 200, { ok: true });
			return;
		}
	}

	if (method === "POST" && (pathname === "/api/chat" || pathname === "/api/chat/stream")) {
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
		let voice = false;
		try {
			const parsed = JSON.parse(body) as {
				messages?: Array<{ role?: string; content?: string }>;
				allowedTools?: unknown;
				sessionId?: unknown;
				voice?: unknown;
			};
			voice = parsed.voice === true;
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
		const streamSse = pathname === "/api/chat/stream";
		let lockedRoom: string | undefined;
		try {
			setHealthActive();
			const config = getConfig();
			const autonomous = config.autonomousMode === true;
				const webTools = ["search_web", "fetch_url", "get_weather"];
				const effectiveAllowedTools =
					autonomous
						? allowedTools
						: (() => {
								// Cumplir “siempre internet”: en modo no-autónomo limitamos a web-tools.
								const incoming = Array.isArray(allowedTools) ? allowedTools : [];
								const filtered = incoming.filter((t) => webTools.includes(t));
								return (filtered.length ? filtered : webTools) as string[];
							})();
			const goal = userContent.trim() || "¿Qué hay en esta imagen?";
			// Si el chat es de un proyecto, Shiro usa sus instrucciones y sus archivos.
			const project = projectOfChat(sessionId);
			if (project) touchProject(project.id);
			
			// Procesar comandos
			const commandResult = parseCommand(goal, sessionId ?? "web-default");
			// "/nombre-de-habilidad …": el modelo responde siguiendo esa habilidad.
			const skill = matchSkillCommand(goal)?.skill;
			if (commandResult?.executed) {
				console.log(`📝 Comando /${goal.slice(1).split(/\s/)[0]} ejecutado`);
				if (streamSse) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
					});
					sendSseData(res, { type: "done", content: commandResult.content });
					res.end();
				} else {
					sendJson(res, 200, { content: commandResult.content });
				}
				return;
			}
			
			// Salas con varios agentes: órdenes ("activa Viernes", "agrega a Lunes"…) y quién responde.
			const agents = currentAgents();
			const roomId = sessionId && isValidSessionId(sessionId) ? sessionId : undefined;
			let roomPlan: RoomPlan | null = null;
			if (roomId && !commandResult) {
				roomPlan = planRoomTurn(goal, { sessionId: roomId, room: getRoom(roomId, agents), agents, assistantName: state.name });
			}
			if (roomPlan && roomId) {
				if (roomTurns.has(roomId)) {
					sendJson(res, 409, { error: "Espera a que termine la respuesta anterior." });
					return;
				}
				roomTurns.add(roomId);
				lockedRoom = roomId;
				if (roomPlan.changed) {
					if (roomPlan.room) saveRoom(roomPlan.room);
					else deleteRoom(roomId);
				}
			}
			const roomPayload = roomPlan ? { room: publicRoom(roomPlan.room, agents), openVoice: roomPlan.openVoice === true } : null;
			// Orden de sala sin modelo: respuesta fija a nombre del agente (o del asistente).
			if (roomPlan?.reply) {
				const agent = roomPlan.reply.agent ? publicAgent(roomPlan.reply.agent) : null;
				if (streamSse) {
					res.writeHead(200, {
						"Content-Type": "text/event-stream; charset=utf-8",
						"Cache-Control": "no-cache, no-transform",
						Connection: "keep-alive",
					});
					sendSseData(res, { type: "room", ...roomPayload });
					sendSseData(res, { type: "done", content: roomPlan.reply.text, agent });
					res.end();
				} else {
					sendJson(res, 200, { content: roomPlan.reply.text, agent, ...roomPayload });
				}
				return;
			}
			let turn: AgentTurn | undefined;
			const speaker = roomPlan?.responder;
			if (speaker && roomPlan?.room) {
				turn = prepareAgentTurn(speaker, {
					room: roomPlan.room,
					agents,
					messages: incoming,
					assistantName: state.name,
					baseTools: effectiveAllowedTools,
					autonomous,
				});
			}
			const speakerInfo = speaker ? { agent: publicAgent(speaker) } : {};

			console.log(
				"🛠️ Tools:",
				(effectiveAllowedTools as string[] | undefined)?.length || "todas (15)",
				"| Autonomous:",
				autonomous,
				"| Msg:",
				goal.slice(0, 30),
			);
			if (streamSse) {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				});
				sendSseData(res, { type: "start" });
				if (roomPayload?.room && roomPlan?.changed) sendSseData(res, { type: "room", ...roomPayload });
				if (speaker) sendSseData(res, { type: "agent", agent: publicAgent(speaker) });
				// Si el navegador corta la conexión (botón "Detener"), se cancela el modelo y las tools pendientes.
				const abort = new AbortController();
				res.on("close", () => {
					if (!res.writableEnded) abort.abort();
				});
				try {
					const content = await runAgent(goal, {
						llm: turn?.llm ?? getLLM(),
						agentName: turn?.agentName ?? state.name,
						tokenBudget: 8000,
						textOnly: false,
						allowedTools: turn ? turn.allowedTools : effectiveAllowedTools,
						explainMode: config.explainMode,
						conversation: turn?.conversation ?? incoming,
						persona: turn?.persona,
						room: turn?.room,
						userProfile: getUserProfile(),
						onStreamDelta: (chunk) => sendSseData(res, { type: "delta", text: chunk }),
						onToolEvent: (e) =>
							sendSseData(res, e.phase === "end" ? { type: "tool", ...e, image: screenshotUrl(e.image) } : { type: "tool", ...e }),
						approver: createSseApprover(res, sessionId ?? "web-default"),
						signal: abort.signal,
						voice,
						mcp: turn ? turn.mcp : autonomous,
						skill,
						sessionId,
						projectId: project?.id,
					}, workspaceContext ?? undefined);
					if (abort.signal.aborted) return;
					sendSseData(res, { type: "done", content, ...speakerInfo });
					res.end();
				} catch (errIn) {
					const msgIn = errIn instanceof Error ? errIn.message : String(errIn);
					sendSseData(res, { type: "error", message: msgIn });
					res.end();
				}
				return;
			}
			const content = await runAgent(goal, {
				llm: turn?.llm ?? getLLM(),
				agentName: turn?.agentName ?? state.name,
				tokenBudget: 8000,
				textOnly: false,
				allowedTools: turn ? turn.allowedTools : effectiveAllowedTools,
				explainMode: config.explainMode,
				conversation: turn?.conversation ?? incoming,
				persona: turn?.persona,
				room: turn?.room,
				userProfile: getUserProfile(),
				sessionId,
				projectId: project?.id,
			}, workspaceContext ?? undefined);
			sendJson(res, 200, { content, ...speakerInfo, ...(roomPayload ?? {}) });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (streamSse && res.headersSent) {
				sendSseData(res, { type: "error", message });
				res.end();
			} else {
				sendJson(res, 502, { error: message });
			}
		} finally {
			if (lockedRoom) roomTurns.delete(lockedRoom);
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
		sendJson(res, 200, { reminders: await getReminders() });
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
			const reminder = await createReminder({
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
			const result = await completeReminder(id);
			if (result) {
				sendJson(res, 200, { success: true, reminder: result });
			} else {
				sendJson(res, 404, { error: "Reminder not found" });
			}
			return;
		}
		if (payload.action === "delete") {
			const { deleteReminder } = await import("./core/reminders/reminders.js");
			const result = await deleteReminder(id);
			sendJson(res, 200, { success: result });
			return;
		}
		sendJson(res, 400, { error: "Invalid action" });
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
