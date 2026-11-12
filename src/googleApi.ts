/**
 * Ajustes → Conexiones → Google (correo y calendario):
 * - `GET /api/google/status`: si hay credencial y cuenta conectada (el secreto nunca vuelve al navegador).
 * - `POST /api/google/connect` `{ clientId?, clientSecret? }`: guarda la credencial y da la dirección de Google.
 * - `GET /api/google/callback`: la vuelta desde Google. Es la única ruta de la API sin contraseña (la abre Google,
 *   no la web de Aku); la protege el `state` aleatorio de un solo uso de `googleAuth.ts`.
 * - `POST /api/google/disconnect`: quita el permiso (también en Google).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "./http.js";
import { getConfig, setConfig } from "./config/config.js";
import { disconnectGoogle, finishGoogleAuth, getGoogleStatus, redirectUri, startGoogleAuth } from "./core/google/googleAuth.js";

export const GOOGLE_CALLBACK_PATH = "/api/google/callback";

/** Página corta que ve el usuario al volver de Google. */
function resultPage(res: ServerResponse, ok: boolean, text: string): void {
	const safe = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
	res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aku · Google</title>` +
			`<body style="font-family:system-ui,sans-serif;background:#1f1f22;color:#ececec;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px">` +
			`<div style="max-width:440px;text-align:center"><h2>${ok ? "Cuenta conectada" : "No se pudo conectar"}</h2><p>${safe}</p>` +
			`<p style="color:#9a9aa0">Ya puedes cerrar esta pestaña y volver a Aku.</p></div></body>`,
	);
}

export async function handleGoogleApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, parsedUrl: URL, port: number): Promise<boolean> {
	if (!pathname.startsWith("/api/google/")) return false;

	if (method === "GET" && pathname === GOOGLE_CALLBACK_PATH) {
		try {
			const s = await finishGoogleAuth(parsedUrl.searchParams);
			resultPage(res, true, `Aku ya puede leer tu correo y tu calendario${s.email ? ` (${s.email})` : ""}. Enviar un correo o crear un evento siempre te pedirá permiso.`);
		} catch (err) {
			resultPage(res, false, err instanceof Error ? err.message : String(err));
		}
		return true;
	}

	if (method === "GET" && pathname === "/api/google/status") {
		sendJson(res, 200, { ...getGoogleStatus(), redirectUri: redirectUri(port), hasSecret: Boolean(getConfig().googleClientSecret) });
		return true;
	}

	if (method === "POST" && pathname === "/api/google/connect") {
		try {
			const body = await readJson<{ clientId?: unknown; clientSecret?: unknown }>(req).catch(() => ({}) as Record<string, unknown>);
			const patch: Record<string, string> = {};
			const id = typeof body.clientId === "string" ? body.clientId.trim() : "";
			const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
			if (id) {
				if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error("El id de cliente termina en .apps.googleusercontent.com: revisa que lo copiaste entero.");
				patch.googleClientId = id;
			}
			if (secret) patch.googleClientSecret = secret;
			if (Object.keys(patch).length) setConfig(patch);
			sendJson(res, 200, { url: startGoogleAuth(port) });
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	if (method === "POST" && pathname === "/api/google/disconnect") {
		await disconnectGoogle();
		sendJson(res, 200, getGoogleStatus());
		return true;
	}
	return false;
}
