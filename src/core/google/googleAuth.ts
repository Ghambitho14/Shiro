/**
 * Cuenta de Google del usuario (correo y calendario) con OAuth 2.0 de «App de escritorio»:
 * - La credencial (id y secreto) la crea el usuario en su propio Google Cloud: Aku no usa ninguna suya.
 * - Al conectar, el navegador va a Google y vuelve a `http://127.0.0.1:<puerto>/api/google/callback`
 *   (redirección a este mismo equipo, como piden las apps de escritorio), con `state` aleatorio de un solo uso
 *   y PKCE. Por eso solo se puede conectar desde el navegador de este PC.
 * - Los permisos (token de acceso y de renovación) quedan en `data/google-token.json`, siempre en este equipo,
 *   y nunca van al navegador ni al modelo.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, getConfig } from "../../config/config.js";

export const GOOGLE_SCOPES = [
	"openid",
	"email",
	"https://www.googleapis.com/auth/gmail.readonly",
	// Borradores y enviar (incluye gmail.send). Enviar siempre pide permiso en Aku.
	"https://www.googleapis.com/auth/gmail.compose",
	"https://www.googleapis.com/auth/calendar.events",
];

const TOKEN_FILE = () => join(DATA_DIR, "google-token.json");
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const STATE_TTL_MS = 10 * 60 * 1000;

type Token = { access_token: string; refresh_token?: string; expires_at: number; scope: string; email?: string };

/** Conexiones a medio hacer: state → { verificador PKCE, dirección de vuelta, cuándo }. */
const pending = new Map<string, { verifier: string; redirect: string; at: number }>();

function readToken(): Token | null {
	try {
		return JSON.parse(readFileSync(TOKEN_FILE(), "utf-8")) as Token;
	} catch {
		return null;
	}
}

function writeToken(t: Token): void {
	writeFileSync(TOKEN_FILE(), JSON.stringify(t), { encoding: "utf-8", mode: 0o600 });
	try {
		chmodSync(TOKEN_FILE(), 0o600);
	} catch {
		/* en Windows no aplica */
	}
}

export type GoogleStatus = { configured: boolean; connected: boolean; email?: string; scopes: string[]; clientId?: string };

export function getGoogleStatus(): GoogleStatus {
	const c = getConfig();
	const t = readToken();
	return {
		configured: Boolean(c.googleClientId && c.googleClientSecret),
		connected: Boolean(t?.refresh_token),
		email: t?.email,
		scopes: t?.scope ? t.scope.split(" ") : [],
		clientId: c.googleClientId,
	};
}

/** ¿Hay una cuenta conectada? (para ofrecer o no las herramientas `email` y `calendar`). */
export function googleConnected(): boolean {
	return Boolean(getConfig().googleClientId && readToken()?.refresh_token);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Dirección a la que manda Google de vuelta: siempre este equipo (127.0.0.1) y el puerto de Aku. */
export function redirectUri(port: number): string {
	return `http://127.0.0.1:${port}/api/google/callback`;
}

/** Empieza a conectar: devuelve la dirección de Google a la que hay que ir. */
export function startGoogleAuth(port: number): string {
	const c = getConfig();
	if (!c.googleClientId || !c.googleClientSecret) throw new Error("Primero pega el id y el secreto de tu credencial de Google.");
	const now = Date.now();
	for (const [k, v] of pending) if (now - v.at > STATE_TTL_MS) pending.delete(k);
	const state = b64url(randomBytes(24));
	const verifier = b64url(randomBytes(48));
	const redirect = redirectUri(port);
	pending.set(state, { verifier, redirect, at: now });
	const q = new URLSearchParams({
		client_id: c.googleClientId,
		redirect_uri: redirect,
		response_type: "code",
		scope: GOOGLE_SCOPES.join(" "),
		access_type: "offline",
		// Siempre pide confirmar: así Google entrega el token de renovación aunque ya se hubiera dado permiso antes.
		prompt: "consent",
		state,
		code_challenge: b64url(createHash("sha256").update(verifier).digest()),
		code_challenge_method: "S256",
	});
	return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
		signal: AbortSignal.timeout(20_000),
	});
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const code = String(data.error ?? res.status);
		if (code === "invalid_grant") throw new Error("Google ya no acepta el permiso guardado (caducó o lo quitaste). Vuelve a conectar la cuenta en Ajustes → Conexiones.");
		if (code === "invalid_client") throw new Error("Google no reconoce la credencial: revisa el id y el secreto en Ajustes → Conexiones.");
		throw new Error(`Google respondió ${code}${data.error_description ? `: ${String(data.error_description)}` : ""}.`);
	}
	return data;
}

/** El correo de la cuenta, sacado del id_token que Google acaba de entregar (por HTTPS, así que no hace falta verificar la firma). */
function emailFromIdToken(idToken: unknown): string | undefined {
	if (typeof idToken !== "string") return undefined;
	try {
		const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf-8")) as { email?: string };
		return typeof payload.email === "string" ? payload.email : undefined;
	} catch {
		return undefined;
	}
}

/** Vuelta de Google: cambia el código por los permisos. Lanza un error en español si algo no cuadra. */
export async function finishGoogleAuth(params: URLSearchParams): Promise<GoogleStatus> {
	const state = params.get("state") ?? "";
	const p = pending.get(state);
	pending.delete(state);
	if (!p || Date.now() - p.at > STATE_TTL_MS) throw new Error("Este enlace de Google ya no vale. Vuelve a pulsar «Conectar» en Ajustes → Conexiones.");
	if (params.get("error")) throw new Error(params.get("error") === "access_denied" ? "No diste permiso en Google." : `Google respondió: ${params.get("error")}.`);
	const code = params.get("code");
	if (!code) throw new Error("Google no devolvió el código.");
	const c = getConfig();
	const data = await tokenRequest({
		code,
		client_id: c.googleClientId ?? "",
		client_secret: c.googleClientSecret ?? "",
		redirect_uri: p.redirect,
		grant_type: "authorization_code",
		code_verifier: p.verifier,
	});
	if (typeof data.access_token !== "string") throw new Error("Google no entregó el permiso.");
	const previous = readToken();
	writeToken({
		access_token: data.access_token,
		refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : previous?.refresh_token,
		expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
		scope: typeof data.scope === "string" ? data.scope : GOOGLE_SCOPES.join(" "),
		email: emailFromIdToken(data.id_token) ?? previous?.email,
	});
	return getGoogleStatus();
}

/** Quita la conexión: avisa a Google que el permiso ya no vale y borra el archivo. */
export async function disconnectGoogle(): Promise<void> {
	const t = readToken();
	if (t?.refresh_token || t?.access_token) {
		await fetch(REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }),
			signal: AbortSignal.timeout(10_000),
		}).catch(() => {});
	}
	if (existsSync(TOKEN_FILE())) rmSync(TOKEN_FILE(), { force: true });
}

let refreshing: Promise<string> | null = null;

/** Un token de acceso válido (lo renueva si le queda menos de un minuto). */
async function accessToken(): Promise<string> {
	const t = readToken();
	if (!t?.refresh_token) throw new Error("No hay una cuenta de Google conectada. Conéctala en Ajustes → Conexiones.");
	if (t.expires_at - Date.now() > 60_000) return t.access_token;
	refreshing ??= (async () => {
		const c = getConfig();
		const data = await tokenRequest({ client_id: c.googleClientId ?? "", client_secret: c.googleClientSecret ?? "", refresh_token: t.refresh_token ?? "", grant_type: "refresh_token" });
		if (typeof data.access_token !== "string") throw new Error("Google no renovó el permiso.");
		writeToken({ ...t, access_token: data.access_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
		return data.access_token;
	})().finally(() => (refreshing = null));
	return refreshing;
}

/** Petición a una API de Google con la cuenta conectada. Devuelve el JSON o lanza un error en español. */
export async function googleApi<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
	if (!url.startsWith("https://gmail.googleapis.com/") && !url.startsWith("https://www.googleapis.com/")) throw new Error("Dirección de Google no permitida.");
	const token = await accessToken();
	const res = await fetch(url, {
		method: init.method ?? "GET",
		headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
		body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		signal: init.signal ?? AbortSignal.timeout(30_000),
	});
	if (res.status === 204) return {} as T;
	const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
	if (!res.ok) {
		const msg = data.error?.message ?? `error ${res.status}`;
		if (res.status === 403 && /has not been used|is disabled/i.test(msg)) {
			throw new Error(`Falta activar la API en tu Google Cloud (Gmail API o Google Calendar API): ${msg.slice(0, 200)}`);
		}
		if (res.status === 403 && /insufficient/i.test(msg)) throw new Error("La cuenta conectada no dio ese permiso. Vuelve a conectarla en Ajustes → Conexiones y acepta todo.");
		throw new Error(`Google respondió ${res.status}: ${msg.slice(0, 300)}`);
	}
	return data as T;
}
