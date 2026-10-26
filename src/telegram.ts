/**
 * Puente de Telegram: Shiro responde por un bot de Telegram (el token lo da @BotFather).
 *
 * - Usa "sondeo largo" (getUpdates) desde el propio servidor: no hay que abrir puertos.
 * - Solo responde a los chats que autorizas en Ajustes → Conexiones. Cualquiera puede
 *   encontrar un bot, así que el resto recibe un aviso y queda como solicitud pendiente
 *   (sin tocar el modelo: no gasta tu cuota ni ve tu memoria).
 * - Sin forma de pedir permiso, el control del PC y las acciones peligrosas no están
 *   disponibles (runAgent sin approver), igual que en WhatsApp.
 * - El token va en la URL de la API de Telegram: nunca se escribe en logs ni se envía al navegador.
 */
import { getConfig, setConfig } from "./config/config.js";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { buildWorkspaceContext } from "./workspace.js";
import { runAgent } from "./core/agent/Agent.js";
import { getLLM } from "./core/llm/getLLM.js";
import { setHealthActive } from "./core/health/HealthManager.js";
import { getChatSession, getOrCreateLinkedChatSession, saveChatSession, type ChatMessage } from "./chat/ChatStore.js";
import type { ContentPart } from "./core/agent/Types.js";
import { getMessagePreview } from "./core/agent/contentUtils.js";

const TG_CHANNEL = "telegram";
const API = "https://api.telegram.org";
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
/** Telegram admite 4096 caracteres por mensaje; se deja margen. */
const MAX_MESSAGE_CHARS = 4000;
const MAX_PENDING = 10;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgChat = { id: number; type: string; first_name?: string; last_name?: string; username?: string; title?: string };
type TgPhoto = { file_id: string; width: number; height: number; file_size?: number };
type TgMessage = { message_id: number; chat: TgChat; text?: string; caption?: string; photo?: TgPhoto[] };
type TgUpdate = { update_id: number; message?: TgMessage };

export type TelegramState = "idle" | "starting" | "ready" | "retrying" | "error";
export type TelegramPending = { id: string; name: string; username?: string; at: string };

const status: { state: TelegramState; botUsername: string | null; lastError: string | null } = {
	state: "idle",
	botUsername: null,
	lastError: null,
};
/** Quién escribió al bot sin estar autorizado (solo en memoria: se olvida al reiniciar). */
const pending = new Map<string, TelegramPending>();
/** Mensajes del mismo chat en orden; chats distintos en paralelo. */
const chatQueues = new Map<string, Promise<void>>();
let loop: AbortController | null = null;

class TelegramError extends Error {
	constructor(
		message: string,
		readonly code?: number,
	) {
		super(message);
	}
}

async function tg<T>(token: string, method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
	let res: Response;
	try {
		res = await fetch(`${API}/bot${token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: signal ?? AbortSignal.timeout(20_000),
		});
	} catch {
		// Nunca se relanza el error original: puede llevar la URL, y la URL lleva el token.
		throw new TelegramError("No hay conexión con Telegram. ¿Tienes internet?");
	}
	const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
	if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code ?? res.status);
	return data.result as T;
}

/** Errores de Telegram explicados en español. */
function explain(err: unknown): string {
	if (err instanceof TelegramError) {
		if (err.code === 401 || err.code === 404) return "El token no es válido. Cópialo otra vez de @BotFather.";
		if (err.code === 409) return "Otro programa está usando este bot (¿Shiro abierto dos veces?). Ciérralo y vuelve a conectar.";
		return err.message;
	}
	return err instanceof Error ? err.message : String(err);
}

/** Parece un token de bot: "123456789:AA...". */
export function looksLikeBotToken(token: string): boolean {
	return /^\d{5,}:[\w-]{30,}$/.test(token.trim());
}

/** Parte un texto largo en mensajes que caben en Telegram, cortando por saltos de línea o espacios. */
export function splitForTelegram(text: string, max = MAX_MESSAGE_CHARS): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > max) {
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
		if (cut < max / 2) cut = max;
		out.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest) out.push(rest);
	return out;
}

function chatName(chat: TgChat): string {
	const full = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
	return (full || chat.title || (chat.username ? `@${chat.username}` : String(chat.id))).slice(0, 100);
}

export function isTelegramChatAllowed(chatId: string): boolean {
	return getConfig().telegramChats.some((c) => c.id === chatId);
}

async function send(token: string, chatId: number | string, text: string): Promise<void> {
	// Texto plano: con parse_mode, un asterisco suelto del modelo haría fallar el envío.
	for (const part of splitForTelegram(text || "(Sin respuesta de texto)")) {
		await tg(token, "sendMessage", { chat_id: chatId, text: part });
	}
}

/** "Escribiendo…" en Telegram mientras Shiro trabaja (dura ~5 s, así que se repite). */
function keepTyping(token: string, chatId: number): () => void {
	const tick = () => void tg(token, "sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
	tick();
	const timer = setInterval(tick, 4500);
	return () => clearInterval(timer);
}

async function downloadPhoto(token: string, photos: TgPhoto[]): Promise<string | null> {
	// Telegram manda varios tamaños de la misma foto, de menor a mayor.
	const best = [...photos].reverse().find((p) => !p.file_size || p.file_size <= MAX_PHOTO_BYTES);
	if (!best) return null;
	const file = await tg<{ file_path?: string }>(token, "getFile", { file_id: best.file_id });
	if (!file.file_path) return null;
	const res = await fetch(`${API}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
	if (!res?.ok) return null;
	return `data:image/jpeg;base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
}

async function buildUserContent(token: string, msg: TgMessage, text: string): Promise<string | ContentPart[]> {
	if (!msg.photo?.length) return text;
	try {
		const image = await downloadPhoto(token, msg.photo);
		if (image) {
			return [
				{ type: "text", text: text || "¿Qué hay en esta imagen?" },
				{ type: "image_url", image_url: { url: image } },
			];
		}
	} catch (err) {
		console.error("  [Telegram] No pude descargar la foto:", explain(err));
	}
	return text || "El usuario envió una foto pero no pude descargarla.";
}

async function answer(token: string, msg: TgMessage, text: string, signal: AbortSignal): Promise<string> {
	const chatId = String(msg.chat.id);
	const userContent = await buildUserContent(token, msg, text);
	const linked = await getOrCreateLinkedChatSession(TG_CHANNEL, chatId, `Telegram ${chatName(msg.chat)}`);
	const withUser: ChatMessage[] = [...linked.messages, { role: "user", content: userContent }];
	await saveChatSession(linked.id, withUser);

	const config = getConfig();
	setHealthActive();
	const response = await runAgent(
		getMessagePreview(userContent) || "¿Qué hay en esta imagen?",
		{
			llm: getLLM(),
			agentName: getState().name,
			tokenBudget: 8000,
			textOnly: false,
			// Sin approver, runAgent ya quita el control del PC y bloquea las acciones peligrosas.
			allowedTools: config.autonomousMode ? undefined : ["search_web", "fetch_url", "get_weather"],
			explainMode: config.explainMode,
			conversation: withUser,
			userProfile: getUserProfile(),
			sessionId: linked.id,
			signal,
		},
		buildWorkspaceContext({ includeLongTermMemory: true }) || undefined,
	);
	// Cancelada por tardar demasiado: el aviso ya se envió, no se guarda una respuesta vacía.
	if (signal.aborted) return "";
	const reply = response.trim() || "(Sin respuesta de texto)";
	const latest = await getChatSession(linked.id);
	await saveChatSession(linked.id, [...(latest?.messages ?? withUser), { role: "assistant", content: reply }]);
	return reply;
}

async function handleMessage(token: string, msg: TgMessage): Promise<void> {
	// Solo chats privados: en un grupo cualquiera del grupo podría usar a Shiro.
	if (msg.chat.type !== "private") return;
	const chatId = String(msg.chat.id);
	const text = (msg.text ?? msg.caption ?? "").trim();

	if (!isTelegramChatAllowed(chatId)) {
		// Se avisa una sola vez por chat, y la lista no crece sin límite.
		if (pending.has(chatId) || pending.size >= MAX_PENDING) return;
		pending.set(chatId, { id: chatId, name: chatName(msg.chat), username: msg.chat.username, at: new Date().toISOString() });
		console.log(`  [Telegram] Solicitud de ${chatName(msg.chat)}: autorízala en Ajustes → Conexiones.`);
		await send(token, msg.chat.id, "Hola. Este asistente es privado. Si eres su dueño, autoriza este chat en Shiro: Ajustes → Conexiones → Telegram.");
		return;
	}
	if (text === "/start") {
		await send(token, msg.chat.id, `¡Hola! Soy ${getState().name}. Escríbeme lo que necesites.`);
		return;
	}
	if (!text && !msg.photo?.length) {
		await send(token, msg.chat.id, "Por ahora solo entiendo texto y fotos.");
		return;
	}

	const stopTyping = keepTyping(token, msg.chat.id);
	// Si tarda demasiado se cancela de verdad (modelo y herramientas), no solo se deja de esperar.
	const cancel = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				cancel.abort();
				reject(new Error("timeout"));
			}, PROCESS_TIMEOUT_MS);
		});
		const reply = await Promise.race([answer(token, msg, text, cancel.signal), timeout]);
		await send(token, msg.chat.id, reply);
	} catch (err) {
		const timedOut = cancel.signal.aborted;
		console.error("  [Telegram] Error respondiendo:", timedOut ? "tardó demasiado" : explain(err));
		await send(
			token,
			msg.chat.id,
			timedOut ? "La respuesta está tardando demasiado. Prueba otra vez." : `⚠️ No pude responder: ${explain(err)}`,
		).catch(() => {});
	} finally {
		clearTimeout(timer);
		stopTyping();
	}
}

function enqueue(token: string, msg: TgMessage): void {
	const key = String(msg.chat.id);
	const next = (chatQueues.get(key) ?? Promise.resolve())
		.then(() => handleMessage(token, msg))
		.catch((err) => console.error("  [Telegram] Error:", explain(err)));
	chatQueues.set(key, next);
	void next.finally(() => {
		if (chatQueues.get(key) === next) chatQueues.delete(key);
	});
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
	});
}

async function pollLoop(token: string, ctrl: AbortController): Promise<void> {
	let offset = 0;
	let failures = 0;
	while (!ctrl.signal.aborted) {
		try {
			const updates = await tg<TgUpdate[]>(
				token,
				"getUpdates",
				{ offset, timeout: 30, allowed_updates: ["message"] },
				AbortSignal.any([ctrl.signal, AbortSignal.timeout(45_000)]),
			);
			// Desconectado (o reconectado con otro bucle) mientras esperaba: estos mensajes ya no son suyos.
			if (ctrl.signal.aborted) return;
			failures = 0;
			if (status.state !== "ready") {
				status.state = "ready";
				status.lastError = null;
			}
			for (const u of updates) {
				offset = u.update_id + 1;
				if (u.message) enqueue(token, u.message);
			}
		} catch (err) {
			if (ctrl.signal.aborted) return;
			// Token revocado u otro programa usando el bot: reintentar no sirve.
			if (err instanceof TelegramError && (err.code === 401 || err.code === 404 || err.code === 409)) {
				status.state = "error";
				status.lastError = explain(err);
				if (loop === ctrl) loop = null;
				console.error("  [Telegram]", status.lastError);
				return;
			}
			failures++;
			status.state = "retrying";
			status.lastError = explain(err);
			await wait(Math.min(30_000, 2_000 * failures), ctrl.signal);
		}
	}
}

export function getTelegramStatus() {
	const c = getConfig();
	return {
		state: status.state,
		botUsername: status.botUsername,
		lastError: status.lastError,
		hasToken: Boolean(c.telegramToken),
		chats: c.telegramChats,
		pending: [...pending.values()],
	};
}

/** Conecta el bot. Con token nuevo, solo se guarda si Telegram lo acepta. */
export async function connectTelegram(newToken?: string): Promise<void> {
	const token = newToken?.trim() || getConfig().telegramToken;
	if (!token) throw new Error("Pega el token de tu bot. Lo consigues en Telegram hablando con @BotFather → /newbot.");
	if (newToken && !looksLikeBotToken(newToken)) {
		throw new Error('Eso no parece un token de bot. Es algo como "123456789:AAH...": cópialo entero del mensaje de @BotFather.');
	}
	stopLoop();
	const ctrl = new AbortController();
	loop = ctrl;
	status.state = "starting";
	status.lastError = null;
	try {
		const me = await tg<TgUser>(token, "getMe");
		// Con un webhook activo, getUpdates no funciona.
		await tg(token, "deleteWebhook");
		status.botUsername = me.username ?? null;
	} catch (err) {
		if (loop === ctrl) loop = null;
		status.state = "error";
		status.lastError = explain(err);
		throw new Error(status.lastError);
	}
	setConfig({ ...(newToken ? { telegramToken: token } : {}), telegramEnabled: true });
	status.state = "ready";
	console.log(`  [Telegram] Conectado como @${status.botUsername}.`);
	void pollLoop(token, ctrl);
}

function stopLoop(): void {
	loop?.abort();
	loop = null;
	status.state = "idle";
	status.lastError = null;
}

export function disconnectTelegram(): void {
	stopLoop();
	setConfig({ telegramEnabled: false });
}

/** Al arrancar el servidor: reconecta si la última vez quedó conectado. */
export function autoStartTelegram(): void {
	const c = getConfig();
	if (!c.telegramEnabled || !c.telegramToken) return;
	connectTelegram().catch((err) => console.error("  [Telegram] No se pudo conectar:", err instanceof Error ? err.message : err));
}

export async function allowTelegramChat(chatId: string): Promise<void> {
	const request = pending.get(chatId);
	if (!request) throw new Error("Esa solicitud ya no está. Vuelve a escribirle al bot desde Telegram.");
	const others = getConfig().telegramChats.filter((c) => c.id !== chatId);
	setConfig({ telegramChats: [...others, { id: chatId, name: request.name }] });
	pending.delete(chatId);
	const token = getConfig().telegramToken;
	if (token) await send(token, chatId, `¡Listo! Ya puedes hablar con ${getState().name}.`).catch(() => {});
}

export function revokeTelegramChat(chatId: string): void {
	setConfig({ telegramChats: getConfig().telegramChats.filter((c) => c.id !== chatId) });
}
