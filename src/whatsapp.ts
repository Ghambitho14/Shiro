import * as qrcode from "qrcode-terminal";
import WhatsAppWebJs, { Client, type Message } from "whatsapp-web.js";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import { vllmClient } from "./core/llm/vllmClient.js";
import { setHealthActive } from "./core/health/HealthManager.js";
import { getChatSession, getOrCreateLinkedChatSession, saveChatSession, type ChatMessage } from "./chat/ChatStore.js";

const WA_CHANNEL = "whatsapp-web";
const WA_CLIENT_ID = process.env.WA_CLIENT_ID?.trim() || "shiro-personal";
const WA_ALLOWED_CHAT = process.env.WA_ALLOWED_CHAT?.trim();
const WA_REPLY_TO_OWN_MESSAGES = process.env.WA_REPLY_TO_OWN_MESSAGES === "1";
const WA_ONLY_PRIVATE = process.env.WA_ONLY_PRIVATE !== "0";
const DEFAULT_WIN_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WA_CHROME_PATH = process.env.WA_CHROME_PATH?.trim() || (process.platform === "win32" ? DEFAULT_WIN_CHROME : undefined);

const chatMemories = new Map<string, MemoryManager>();
const LocalAuth = WhatsAppWebJs.LocalAuth;
let client: Client | null = null;
let starting = false;
let messageQueue: Promise<void> = Promise.resolve();

function getMemoryForChat(chatId: string): MemoryManager {
	const existing = chatMemories.get(chatId);
	if (existing) return existing;
	const created = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	chatMemories.set(chatId, created);
	return created;
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

function shouldIgnoreMessage(message: Message): boolean {
	if (!WA_REPLY_TO_OWN_MESSAGES && message.fromMe) return true;
	if (WA_ONLY_PRIVATE && message.from.endsWith("@g.us")) return true;
	if (WA_ALLOWED_CHAT && message.from !== WA_ALLOWED_CHAT) return true;
	if (!isTextMessage(message)) return true;
	return false;
}

function buildSessionTitle(chatId: string): string {
	return `WhatsApp ${chatId}`;
}

async function processIncomingMessage(message: Message): Promise<void> {
	if (shouldIgnoreMessage(message)) return;

	const userText = message.body.trim();
	const linked = getOrCreateLinkedChatSession(WA_CHANNEL, message.from, buildSessionTitle(message.from));
	const withUser: ChatMessage[] = [...linked.messages, { role: "user", content: userText }];
	const persistedUser = saveChatSession(linked.id, withUser);
	if (!persistedUser) return;

	const state = getState();
	const config = getConfig();
	const autonomous = config.autonomousMode !== false;
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
	setHealthActive();
	const response = await runAgent(
		userText,
		{
			llm: vllmClient,
			memory: getMemoryForChat(message.from),
			agentName: state.name,
			tokenBudget: 8000,
			usePlanner: autonomous,
			textOnly: !autonomous,
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
		messageQueue = messageQueue
			.then(async () => {
				await processIncomingMessage(message);
			})
			.catch((err) => {
				const text = err instanceof Error ? err.message : String(err);
				console.error("  Error procesando mensaje de WhatsApp:", text);
			});
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
		authStrategy: new LocalAuth({ clientId: WA_CLIENT_ID }),
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
