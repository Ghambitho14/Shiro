import * as qrcode from "qrcode-terminal";
import WhatsAppWebJs, { Client, type Message } from "whatsapp-web.js";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig, DATA_DIR } from "./config/config.js";
import { join } from "node:path";
import { buildWorkspaceContext } from "./workspace.js";
import { createSessionMemoryStore } from "./core/memory/SessionMemoryStore.js";
import { runAgent } from "./core/agent/Agent.js";
import { getLLM } from "./core/llm/getLLM.js";
import { setHealthActive } from "./core/health/HealthManager.js";
import { getChatSession, getOrCreateLinkedChatSession, saveChatSession, type ChatMessage } from "./chat/ChatStore.js";
import type { ContentPart } from "./core/agent/Types.js";
import { getMessagePreview } from "./core/agent/contentUtils.js";

const WA_CHANNEL = "whatsapp-web";
const WA_CLIENT_ID = process.env.WA_CLIENT_ID?.trim() || "shiro-personal";
const WA_ALLOWED_CHAT = process.env.WA_ALLOWED_CHAT?.trim();
const WA_REPLY_TO_OWN_MESSAGES = process.env.WA_REPLY_TO_OWN_MESSAGES === "1";
const WA_ONLY_PRIVATE = process.env.WA_ONLY_PRIVATE !== "0";
const DEFAULT_WIN_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WA_CHROME_PATH = process.env.WA_CHROME_PATH?.trim() || (process.platform === "win32" ? DEFAULT_WIN_CHROME : undefined);

const chatMemoryStore = createSessionMemoryStore();
const LocalAuth = WhatsAppWebJs.LocalAuth;
let client: Client | null = null;
let starting = false;

/** Per-chat promise chains: messages in the same chat run in order; different chats run in parallel (up to semaphore). */
const chatQueues = new Map<string, Promise<void>>();

const PROCESS_TIMEOUT_MS = Number(process.env.WA_PROCESS_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min default
const MAX_CONCURRENT_CHATS = Math.max(1, Number(process.env.WA_MAX_CONCURRENT_CHATS) || 5);
let concurrentChats = 0;
const pendingResolvers: Array<() => void> = [];

function acquireConcurrency(): Promise<void> {
	if (concurrentChats < MAX_CONCURRENT_CHATS) {
		concurrentChats++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		pendingResolvers.push(resolve);
	});
}

function releaseConcurrency(): void {
	concurrentChats--;
	if (pendingResolvers.length > 0 && concurrentChats < MAX_CONCURRENT_CHATS) {
		concurrentChats++;
		(pendingResolvers.shift() as () => void)();
	}
}

export type WhatsAppBridgeState = "idle" | "starting" | "qr" | "ready" | "auth_failure" | "disconnected" | "error";

type WhatsAppBridgeStatus = {
	state: WhatsAppBridgeState;
	clientId: string;
	lastQr: string | null;
	lastQrAt: string | null;
	connectedAt: string | null;
	lastError: string | null;
};

const status: WhatsAppBridgeStatus = {
	state: "idle",
	clientId: WA_CLIENT_ID,
	lastQr: null,
	lastQrAt: null,
	connectedAt: null,
	lastError: null,
};

function setState(next: WhatsAppBridgeState, err?: string): void {
	status.state = next;
	if (next === "ready") {
		status.connectedAt = new Date().toISOString();
		status.lastError = null;
	}
	if (next === "qr") {
		status.lastError = null;
	}
	if (err) {
		status.lastError = err;
	}
}

function isTextMessage(message: Message): boolean {
	return message.type === "chat" && typeof message.body === "string" && message.body.trim().length > 0;
}

function isImageMessage(message: Message): boolean {
	return message.type === "image";
}

function shouldIgnoreMessage(message: Message): boolean {
	if (!WA_REPLY_TO_OWN_MESSAGES && message.fromMe) return true;
	if (WA_ONLY_PRIVATE && message.from.endsWith("@g.us")) return true;
	if (WA_ALLOWED_CHAT && message.from !== WA_ALLOWED_CHAT) return true;
	if (!isTextMessage(message) && !isImageMessage(message)) return true;
	return false;
}

function buildSessionTitle(chatId: string): string {
	return `WhatsApp ${chatId}`;
}

async function buildUserContent(message: Message): Promise<string | ContentPart[]> {
	if (isImageMessage(message)) {
		const caption = (typeof message.body === "string" ? message.body : "").trim();
		const parts: ContentPart[] = [];
		if (caption) parts.push({ type: "text", text: caption });
		else parts.push({ type: "text", text: "¿Qué hay en esta imagen?" });
		try {
			const media = await message.downloadMedia();
			if (media && media.data) {
				const mime = media.mimetype?.startsWith("image/") ? media.mimetype : "image/jpeg";
				parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${media.data}` } });
			}
		} catch (err) {
			console.error("  Error descargando imagen de WhatsApp:", err instanceof Error ? err.message : err);
			return caption || "El usuario envió una imagen pero no pude descargarla.";
		}
		return parts.length > 1 ? parts : caption || "Imagen recibida.";
	}
	return (typeof message.body === "string" ? message.body : "").trim();
}

async function processIncomingMessage(message: Message): Promise<void> {
	if (shouldIgnoreMessage(message)) return;

	const userContent = await buildUserContent(message);
	const linked = getOrCreateLinkedChatSession(WA_CHANNEL, message.from, buildSessionTitle(message.from));
	const withUser: ChatMessage[] = [...linked.messages, { role: "user", content: userContent }];
	const persistedUser = saveChatSession(linked.id, withUser);
	if (!persistedUser) return;

	const goal = getMessagePreview(userContent) || "¿Qué hay en esta imagen?";
	const state = getState();
	const config = getConfig();
	const autonomous = config.autonomousMode !== false;
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
	setHealthActive();
	const response = await runAgent(
		goal,
		{
			llm: getLLM(),
			memory: chatMemoryStore.getMemory(message.from),
			agentName: state.name,
			tokenBudget: 8000,
			usePlanner: autonomous,
			textOnly: !autonomous,
			conversation: withUser,
			userProfile: getUserProfile(),
		},
		workspaceContext || undefined,
	);
	const text = response.trim() || "(Sin respuesta de texto)";

	const latest = getChatSession(linked.id);
	const baseMessages = latest?.messages ?? withUser;
	saveChatSession(linked.id, [...baseMessages, { role: "assistant", content: text }]);
	await message.reply(text);
}

/**
 * Runs processIncomingMessage with a timeout. On timeout, logs and sends a short reply; semaphore is released by caller's finally().
 */
async function processWithTimeout(message: Message): Promise<void> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(() => reject(new Error("WA_PROCESS_TIMEOUT")), PROCESS_TIMEOUT_MS);
	});
	try {
		await Promise.race([processIncomingMessage(message), timeoutPromise]);
	} catch (err) {
		if (err instanceof Error && err.message === "WA_PROCESS_TIMEOUT") {
			console.error("  Timeout procesando mensaje de WhatsApp (chat:", message.from, ")");
			await message.reply("La respuesta está tardando demasiado. Puedes intentar de nuevo.");
			return;
		}
		throw err;
	}
}

type StartBridgeOptions = {
	printQrToConsole?: boolean;
};

function attachClientEvents(waClient: Client, opts: StartBridgeOptions): void {
	waClient.on("qr", (qr) => {
		status.lastQr = qr;
		status.lastQrAt = new Date().toISOString();
		setState("qr");
		if (opts.printQrToConsole) {
			console.log("  Escanea este QR con WhatsApp:");
			qrcode.generate(qr, { small: true });
			console.log("");
		}
	});

	waClient.on("ready", () => {
		setState("ready");
		console.log("  WhatsApp conectado. Shiro ya puede responder mensajes.\n");
	});

	waClient.on("authenticated", () => {
		console.log("  Sesión autenticada.");
	});

	waClient.on("auth_failure", (msg) => {
		setState("auth_failure", msg);
		console.error("  Falló autenticación de WhatsApp:", msg);
	});

	waClient.on("disconnected", (reason) => {
		setState("disconnected", String(reason));
		console.log("  WhatsApp desconectado:", reason);
		client = null;
	});

	waClient.on("message", (message) => {
		const chatId = message.from;
		const prev = chatQueues.get(chatId) ?? Promise.resolve();
		const next = prev
			.then(() => acquireConcurrency())
			.then(() => processWithTimeout(message))
			.finally(() => releaseConcurrency())
			.catch((err) => {
				const text = err instanceof Error ? err.message : String(err);
				console.error("  Error procesando mensaje de WhatsApp:", text);
			});
		chatQueues.set(chatId, next);
	});
}

export function getWhatsAppBridgeStatus(): Omit<WhatsAppBridgeStatus, "lastQr"> & { hasQr: boolean; qr: string | null } {
	return {
		state: status.state,
		clientId: status.clientId,
		lastQrAt: status.lastQrAt,
		connectedAt: status.connectedAt,
		lastError: status.lastError,
		hasQr: Boolean(status.lastQr),
		qr: status.lastQr,
	};
}

export async function startWhatsAppBridge(opts: StartBridgeOptions = {}): Promise<void> {
	if (client || starting) return;
	starting = true;
	setState("starting");
	status.lastError = null;

	const waClient = new Client({
		authStrategy: new LocalAuth({ clientId: WA_CLIENT_ID, dataPath: join(DATA_DIR, "wa-auth") }),
		puppeteer: {
			headless: true,
			executablePath: WA_CHROME_PATH,
			args: ["--no-sandbox", "--disable-setuid-sandbox"],
		},
	});

	client = waClient;
	attachClientEvents(waClient, opts);
	void waClient.initialize()
		.catch((err) => {
			const text = err instanceof Error ? err.message : String(err);
			setState("error", text);
			client = null;
			console.error("  Error al iniciar WhatsApp bridge:", text);
		})
		.finally(() => {
			starting = false;
		});
}

export async function stopWhatsAppBridge(): Promise<void> {
	if (!client && !starting) {
		setState("idle");
		status.lastQr = null;
		status.lastQrAt = null;
		return;
	}
	const current = client;
	client = null;
	try {
		if (current) await current.destroy();
	} finally {
		starting = false;
		setState("idle");
		status.lastQr = null;
		status.lastQrAt = null;
		status.connectedAt = null;
	}
}

export async function runWhatsAppBridge(): Promise<void> {
	console.log("\n  Shiro WhatsApp bridge (modo personal)\n");
	console.log(`  Cliente: ${WA_CLIENT_ID}`);
	if (WA_ALLOWED_CHAT) console.log(`  Filtro chat permitido: ${WA_ALLOWED_CHAT}`);
	console.log(`  Solo privados: ${WA_ONLY_PRIVATE ? "sí" : "no"}`);
	console.log(`  Responder mensajes propios: ${WA_REPLY_TO_OWN_MESSAGES ? "sí" : "no"}\n`);

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\n  ${signal} recibido. Cerrando WhatsApp bridge...`);
		try {
			await stopWhatsAppBridge();
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			console.error("  Error al cerrar cliente de WhatsApp:", text);
		}
		console.log("  WhatsApp bridge cerrado.\n");
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
	await startWhatsAppBridge({ printQrToConsole: true });
	await new Promise<void>(() => {});
}
