/**
 * Piezas comunes de la API: leer el cuerpo de una petición y responder (JSON, texto o SSE).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** 6 MB para permitir imágenes en base64 en el chat (vision). */
export const MAX_BODY_BYTES = 6 * 1024 * 1024;

export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		req.on("data", (chunk) => {
			const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			totalBytes += piece.byteLength;
			if (totalBytes > MAX_BODY_BYTES) {
				req.destroy();
				reject(new Error("BODY_TOO_LARGE"));
				return;
			}
			chunks.push(piece);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

/** decodeURIComponent que no lanza con URLs mal formadas (devuelve "" y la ruta da 404). */
export function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return "";
	}
}

/** Cuerpo binario (audio para transcribir). */
export function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > maxBytes) {
				req.destroy();
				reject(new Error("BODY_TOO_LARGE"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

export async function readJson<T>(req: IncomingMessage): Promise<T> {
	const body = await readBody(req);
	return (body.trim() ? JSON.parse(body) : {}) as T;
}

export function isBodyTooLargeError(err: unknown): boolean {
	return err instanceof Error && err.message === "BODY_TOO_LARGE";
}

export function send(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
	res.writeHead(status, { "Content-Type": contentType });
	res.end(body);
}

export function sendJson(res: ServerResponse, status: number, data: object): void {
	send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

export function sendSseData(res: ServerResponse, payload: Record<string, unknown>): void {
	if (res.writableEnded) return;
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
