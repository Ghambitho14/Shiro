/**
 * Dibujos de la tool `draw` (`src/core/drawings/drawings.ts`):
 * - GET  /api/drawings/<id>.svg  la imagen para el chat
 * - GET  /api/drawings/<id>      escena de Excalidraw y datos (para el editor `public/dibujo.html`)
 * - PUT  /api/drawings/<id>      guarda lo cambiado en el editor ({ scene, svg })
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readDrawingMeta, readDrawingScene, readDrawingSvg, saveDrawing } from "./core/drawings/drawings.js";
import { isBodyTooLargeError, readBodyBuffer, sendJson } from "./http.js";

/** Un dibujo con imágenes pegadas puede pesar bastante. */
const MAX_BODY = 8 * 1024 * 1024;

export async function handleDrawingsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
	if (!pathname.startsWith("/api/drawings/")) return false;
	const rest = pathname.slice("/api/drawings/".length);

	if (method === "GET" && rest.endsWith(".svg")) {
		const svg = readDrawingSvg(rest.slice(0, -4));
		if (!svg) {
			sendJson(res, 404, { error: "Ese dibujo no existe" });
			return true;
		}
		// Sin scripts aunque alguien abra el SVG directamente.
		res.writeHead(200, {
			"Content-Type": "image/svg+xml; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(svg);
		return true;
	}

	if (method === "GET") {
		const meta = readDrawingMeta(rest);
		const scene = meta ? readDrawingScene(rest) : null;
		if (!meta || !scene) {
			sendJson(res, 404, { error: "Ese dibujo no existe" });
			return true;
		}
		sendJson(res, 200, { ...meta, scene });
		return true;
	}

	if (method === "PUT") {
		let body: { scene?: unknown; svg?: unknown };
		try {
			body = JSON.parse((await readBodyBuffer(req, MAX_BODY)).toString("utf-8")) as typeof body;
		} catch (err) {
			sendJson(res, isBodyTooLargeError(err) ? 413 : 400, { error: isBodyTooLargeError(err) ? "El dibujo es demasiado grande" : "Datos inválidos" });
			return true;
		}
		const r = saveDrawing(rest, body.scene, typeof body.svg === "string" ? body.svg : "");
		if ("error" in r) sendJson(res, 400, { error: r.error });
		else sendJson(res, 200, r);
		return true;
	}
	return false;
}
