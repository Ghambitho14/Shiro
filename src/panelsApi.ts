/**
 * API de los paneles de la web: "Navegador" (el navegador de Shiro en vivo) y "Terminal".
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 * Las rutas están en isSensitivePath (piden contraseña si Shiro está abierto a la red).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { shiroBrowser, type BrowserInput } from "./core/browser/browser.js";
import { terminal } from "./core/terminal/terminal.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

/** Mantiene abierta una respuesta SSE y la conecta con un suscriptor hasta que el navegador la cierre. */
function openSse(req: IncomingMessage, res: ServerResponse, subscribe: (send: (payload: object) => void) => () => void): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": ok\n\n");
	const send = (payload: object) => {
		if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
	};
	const unsubscribe = subscribe(send);
	const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 25_000);
	req.on("close", () => {
		clearInterval(ping);
		unsubscribe();
	});
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Valida un evento de ratón/teclado del panel. */
export function parseBrowserInput(d: Record<string, unknown>): BrowserInput | null {
	switch (d.type) {
		case "click": {
			if (!finite(d.x) || !finite(d.y)) return null;
			const button = d.button === "right" || d.button === "middle" ? d.button : "left";
			return { type: "click", x: d.x, y: d.y, button, clickCount: finite(d.clickCount) ? Math.trunc(d.clickCount) : 1 };
		}
		case "wheel":
			if (!finite(d.x) || !finite(d.y)) return null;
			return { type: "wheel", x: d.x, y: d.y, deltaX: finite(d.deltaX) ? d.deltaX : 0, deltaY: finite(d.deltaY) ? d.deltaY : 0 };
		case "key":
			if (typeof d.key !== "string" || !d.key || d.key.length > 30) return null;
			return { type: "key", key: d.key, ctrl: d.ctrl === true, shift: d.shift === true, alt: d.alt === true, meta: d.meta === true };
		case "text":
			if (typeof d.text !== "string" || !d.text || d.text.length > 5000) return null;
			return { type: "text", text: d.text };
		default:
			return null;
	}
}

export async function handlePanelsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, h: Helpers): Promise<boolean> {
	if (!pathname.startsWith("/api/browser/") && !pathname.startsWith("/api/terminal/")) return false;
	try {
		// ───────── Navegador ─────────
		if (method === "GET" && pathname === "/api/browser/stream") {
			openSse(req, res, (send) => shiroBrowser.subscribe(send));
			return true;
		}
		if (method === "POST" && pathname === "/api/browser/action") {
			const d = await h.readJson<Record<string, unknown>>(req);
			switch (d.action) {
				case "navigate":
					await shiroBrowser.navigate(String(d.url ?? ""));
					break;
				case "back":
				case "forward":
				case "reload":
					await shiroBrowser.history(d.action);
					break;
				case "close":
					await shiroBrowser.close();
					break;
				case "viewport":
					if (!finite(d.width) || !finite(d.height)) {
						h.sendJson(res, 400, { error: "Tamaño inválido" });
						return true;
					}
					await shiroBrowser.setViewport(d.width, d.height, finite(d.dpr) ? d.dpr : 1);
					break;
				default:
					h.sendJson(res, 400, { error: "Acción desconocida" });
					return true;
			}
			h.sendJson(res, 200, { ok: true, state: shiroBrowser.state });
			return true;
		}
		if (method === "POST" && pathname === "/api/browser/input") {
			const ev = parseBrowserInput(await h.readJson<Record<string, unknown>>(req));
			if (!ev) {
				h.sendJson(res, 400, { error: "Evento inválido" });
				return true;
			}
			await shiroBrowser.input(ev);
			h.sendJson(res, 200, { ok: true });
			return true;
		}

		// ───────── Terminal ─────────
		if (method === "GET" && pathname === "/api/terminal/stream") {
			openSse(req, res, (send) => terminal.subscribe(send));
			return true;
		}
		if (method === "POST" && pathname === "/api/terminal/run") {
			const d = await h.readJson<{ command?: unknown }>(req);
			terminal.run(typeof d.command === "string" ? d.command : "", "user");
			h.sendJson(res, 200, { ok: true });
			return true;
		}
		if (method === "POST" && pathname === "/api/terminal/stop") {
			terminal.stop();
			h.sendJson(res, 200, { ok: true });
			return true;
		}
		if (method === "POST" && pathname === "/api/terminal/clear") {
			terminal.clear();
			h.sendJson(res, 200, { ok: true });
			return true;
		}
	} catch (err) {
		if (!res.headersSent) h.sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		return true;
	}
	h.sendJson(res, 404, { error: "No encontrado" });
	return true;
}
