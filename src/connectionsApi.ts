/**
 * Ajustes → Conexiones: WhatsApp (`/api/whatsapp/*`) y Telegram (`/api/telegram/*`; el token nunca vuelve al navegador).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import { getWhatsAppBridgeStatus, startWhatsAppBridge, stopWhatsAppBridge } from "./whatsapp.js";
import { allowTelegramChat, connectTelegram, disconnectTelegram, getTelegramStatus, revokeTelegramChat } from "./telegram.js";
import { readBody, sendJson } from "./http.js";

async function buildWhatsAppResponse(): Promise<{ status: ReturnType<typeof getWhatsAppBridgeStatus>; qrDataUrl: string | null }> {
	const status = getWhatsAppBridgeStatus();
	const qrDataUrl = status.qr ? await QRCode.toDataURL(status.qr, { margin: 1, width: 280 }) : null;
	return { status, qrDataUrl };
}

export async function handleConnectionsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
	if (method === "GET" && pathname === "/api/whatsapp/status") {
		const data = await buildWhatsAppResponse();
		sendJson(res, 200, data);
		return true;
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
		return true;
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
		return true;
	}

	// === TELEGRAM (el token nunca vuelve al navegador) ===
	if (method === "GET" && pathname === "/api/telegram/status") {
		sendJson(res, 200, getTelegramStatus());
		return true;
	}

	if (method === "POST" && pathname.startsWith("/api/telegram/")) {
		let data: { token?: unknown; chatId?: unknown };
		try {
			data = JSON.parse((await readBody(req)) || "{}");
		} catch {
			sendJson(res, 400, { error: "JSON inválido" });
			return true;
		}
		const chatId = typeof data.chatId === "string" && /^-?\d+$/.test(data.chatId) ? data.chatId : "";
		try {
			if (pathname === "/api/telegram/start") await connectTelegram(typeof data.token === "string" ? data.token : undefined);
			else if (pathname === "/api/telegram/stop") disconnectTelegram();
			else if (pathname === "/api/telegram/allow" && chatId) await allowTelegramChat(chatId);
			else if (pathname === "/api/telegram/revoke" && chatId) revokeTelegramChat(chatId);
			else {
				sendJson(res, 404, { error: "No encontrado" });
				return true;
			}
			sendJson(res, 200, getTelegramStatus());
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}
	return false;
}
