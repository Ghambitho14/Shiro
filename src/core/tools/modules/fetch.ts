import { isShiroUrl } from "../../browser/pageModel.js";

/**
 * Así se presenta fetch_url. El servidor de Shiro rechaza su API con este agente: una página
 * (o alguien por WhatsApp) no puede hacer que el modelo lea tus chats o claves de 127.0.0.1,
 * ni siquiera con una redirección.
 */
export const FETCH_USER_AGENT = "Shiro/1.0 (AI agent)";

export async function executeFetchUrl(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const url = String(args.url ?? "").trim();
	if (!url) return { ok: false, content: "URL requerida" };

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, content: `URL inválida: ${url}` };
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, content: "Solo se permiten URLs http o https" };
	}
	if (isShiroUrl(parsed.href)) return { ok: false, content: "La web de Shiro no se lee con fetch_url." };

	const FETCH_TIMEOUT_MS = 15000;
	const FETCH_MAX_BYTES = 150 * 1024;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: { "User-Agent": FETCH_USER_AGENT },
			redirect: "follow",
		});
		clearTimeout(timeoutId);

		if (!res.ok) return { ok: false, content: `HTTP ${res.status}: ${res.statusText}` };

		const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
		if (!contentType.includes("text/") && !contentType.includes("application/json") && !contentType.includes("application/xml")) {
			return { ok: false, content: `La URL no devuelve texto (content-type: ${contentType})` };
		}

		const buf = await res.arrayBuffer();
		if (buf.byteLength > FETCH_MAX_BYTES) {
			return { ok: false, content: `Respuesta demasiado grande (máx ${FETCH_MAX_BYTES / 1024} KB)` };
		}

		const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		return { ok: true, content: text.trim() || "(Contenido vacío)" };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error) {
			if (e.name === "AbortError") return { ok: false, content: "Timeout al conectar con la URL" };
			return { ok: false, content: e.message };
		}
		return { ok: false, content: String(e) };
	}
}
