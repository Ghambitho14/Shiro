/**
 * Voz con un servidor compatible con OpenAI: transcribir (Whisper, `/api/voice/transcribe`) y leer en voz alta
 * (TTS, `/api/voice/speak`), o la voz de Aku sin internet (`ttsEngine: "local"`, `core/voice/localTts.ts`; sus
 * voces en `/api/voice/local*`). También sirve las capturas de pantalla de pc_screenshot (`/api/screenshots/`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config/config.js";
import { installVoice, listLocalVoices, removeVoice, speakLocal } from "./core/voice/localTts.js";
import { SCREENSHOT_DIR } from "./core/pc/pc.js";
import { readBodyBuffer, readJson, safeDecode, send, sendJson } from "./http.js";

export async function handleVoiceApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, parsedUrl: URL): Promise<boolean> {
	// === VOZ: transcribir (Whisper) y leer en voz alta (TTS) con un servidor compatible con OpenAI ===
	if (method === "POST" && pathname === "/api/voice/transcribe") {
		const cfg = getConfig();
		if (!cfg.sttBaseUrl) {
			sendJson(res, 400, { error: "Configura el servidor de reconocimiento de voz en Ajustes → Voz." });
			return true;
		}
		let audio: Buffer;
		try {
			audio = await readBodyBuffer(req, 25 * 1024 * 1024);
		} catch {
			sendJson(res, 413, { error: "Audio demasiado largo (máx. 25 MB)." });
			return true;
		}
		if (audio.byteLength < 200) {
			sendJson(res, 200, { text: "" });
			return true;
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
		return true;
	}

	// === VOZ SIN INTERNET: lista, descargar y borrar voces ===
	if (method === "GET" && pathname === "/api/voice/local") {
		sendJson(res, 200, { voices: listLocalVoices(), selected: getConfig().ttsLocalVoice });
		return true;
	}
	if (method === "POST" && (pathname === "/api/voice/local/install" || pathname === "/api/voice/local/remove")) {
		let voice = "";
		try {
			const body = await readJson<{ voice?: unknown }>(req);
			voice = typeof body.voice === "string" ? body.voice : "";
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		try {
			if (pathname.endsWith("/remove")) removeVoice(voice);
			// La descarga sigue sola; la web mira cómo va con GET /api/voice/local.
			else installVoice(voice).catch(() => {});
			sendJson(res, 200, { voices: listLocalVoices() });
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	if (method === "POST" && pathname === "/api/voice/speak") {
		const cfg = getConfig();
		if (cfg.ttsEngine !== "local" && !cfg.ttsBaseUrl) {
			sendJson(res, 400, { error: "Configura el servidor de voz (TTS) en Ajustes → Voz." });
			return true;
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
			return true;
		}
		if (!text) {
			sendJson(res, 400, { error: "Texto vacío" });
			return true;
		}
		if (cfg.ttsEngine === "local") {
			try {
				// La voz de un agente vale si es una de las de Aku ya descargada; si no, la de Ajustes → Voz.
				const local = listLocalVoices().some((v) => v.id === voiceName && v.installed) ? voiceName : cfg.ttsLocalVoice;
				const wav = await speakLocal(text, local, speed);
				res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
				res.end(wav);
			} catch (err) {
				sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
			}
			return true;
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
		return true;
	}

	// === CAPTURAS DE PANTALLA hechas por pc_screenshot ===
	if (method === "GET" && pathname.startsWith("/api/screenshots/")) {
		const name = safeDecode(pathname.slice("/api/screenshots/".length));
		const file = join(SCREENSHOT_DIR, name);
		if (!/^[\w.-]+\.jpg$/.test(name) || !existsSync(file)) {
			send(res, 404, "Not found");
			return true;
		}
		res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
		res.end(readFileSync(file));
		return true;
	}
	return false;
}
