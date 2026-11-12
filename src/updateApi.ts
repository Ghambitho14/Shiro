/**
 * Actualizaciones de Aku.exe (Ajustes → General → «Versión de Aku»): `GET /api/update` (estado),
 * `POST /api/update/check` (mirar ahora) y `POST /api/update/install` (bajar, comprobar e instalar; Aku se
 * cierra y vuelve a abrirse). La lógica está en `core/update/updater.ts`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./http.js";
import { checkForUpdate, getUpdateState, installUpdate, type FoundUpdate } from "./core/update/updater.js";
import { pushWebNotice } from "./core/reminders/notifications.js";
import { setTrayUpdate } from "./tray.js";

/** Lo que pasa cuando se encuentra una versión nueva: aviso en la web y en el menú de la bandeja. */
export function announceUpdate(u: FoundUpdate): void {
	setTrayUpdate(u.version);
	const now = new Date().toISOString();
	pushWebNotice({
		id: `update-${u.version}`,
		kind: "update",
		title: `Hay una versión nueva de Aku: ${u.version}`,
		description: "Actualízala en Ajustes → General.",
		datetime: now,
		createdAt: now,
	});
}

export async function handleUpdateApi(_req: IncomingMessage, res: ServerResponse, method: string, pathname: string, quit: () => void): Promise<boolean> {
	if (!pathname.startsWith("/api/update")) return false;
	if (method === "GET" && pathname === "/api/update") {
		sendJson(res, 200, getUpdateState());
		return true;
	}
	if (method === "POST" && pathname === "/api/update/check") {
		try {
			const found = await checkForUpdate();
			setTrayUpdate(found?.version ?? "");
			sendJson(res, 200, getUpdateState());
		} catch (err) {
			sendJson(res, 502, { ...getUpdateState(), error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}
	if (method === "POST" && pathname === "/api/update/install") {
		// Se responde ya; la web va mirando con GET /api/update y, al cerrarse Aku, espera a que vuelva.
		installUpdate(quit).catch(() => {});
		sendJson(res, 202, getUpdateState());
		return true;
	}
	return false;
}
