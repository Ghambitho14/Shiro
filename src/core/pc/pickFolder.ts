/**
 * Selector de carpetas de Windows (el moderno del Explorador, `Folders.Pick` del ayudante nativo).
 * Se abre en el PC donde corre Shiro, así que solo se ofrece si la web también está abierta en ese PC.
 */
import type { IncomingMessage } from "node:http";
import { IS_WINDOWS, runNative } from "./powershell.js";

function isLoopback(req: IncomingMessage): boolean {
	const ip = req.socket.remoteAddress ?? "";
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export const canPickFolder = (req: IncomingMessage) => IS_WINDOWS && isLoopback(req);

/** Abre el selector y devuelve la carpeta elegida ("" si se canceló). */
export function pickFolder(title: string): Promise<string> {
	return runNative("[ShiroPc.Folders]::Pick($env:SHIRO_A_TITLE)", { title }, 10 * 60_000);
}
