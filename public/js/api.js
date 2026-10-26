// Comunicación con el servidor de Shiro.

const TOKEN_KEY = "shiroToken";
/** Si el usuario cancela la contraseña, no se vuelve a preguntar en esta pestaña. */
let promptDeclined = false;

function getToken() {
	try {
		return localStorage.getItem(TOKEN_KEY) || "";
	} catch {
		return "";
	}
}

/** fetch con la contraseña del servidor (solo existe si Shiro está abierto a la red). */
export async function authFetch(url, opts = {}) {
	const send = () => {
		const headers = { ...(opts.headers || {}) };
		const t = getToken();
		if (t) headers.Authorization = "Bearer " + t;
		return fetch(url, { ...opts, headers });
	};
	let r = await send();
	if (r.status === 401 && !promptDeclined) {
		const t = window.prompt("Shiro pide contraseña (se muestra en la consola donde lo iniciaste):");
		if (!t) promptDeclined = true;
		if (t && t.trim()) {
			try {
				localStorage.setItem(TOKEN_KEY, t.trim());
			} catch {}
			r = await send();
		}
	}
	return r;
}

/** Petición JSON. Lanza Error con el mensaje del servidor si falla. */
export async function api(url, opts = {}) {
	const init = { ...opts };
	if (init.json !== undefined) {
		init.body = JSON.stringify(init.json);
		init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
		delete init.json;
	}
	let r;
	try {
		r = await authFetch(url, init);
	} catch {
		throw new Error("No hay conexión con Shiro. ¿Sigue abierta la consola donde lo iniciaste?");
	}
	const data = await r.json().catch(() => ({}));
	if (!r.ok) {
		const err = new Error(data.error || `Error ${r.status}`);
		err.status = r.status;
		throw err;
	}
	return data;
}

/**
 * Envía el chat y va recibiendo la respuesta por partes (Server-Sent Events).
 * handlers: onDelta(textoCompleto), onTool(evento), onApproval(evento), onDone(evento),
 * y en salas onAgent(agente que responde) y onRoom({ room, openVoice }).
 */
export async function streamChat(body, handlers, signal) {
	let r;
	try {
		r = await authFetch("/api/chat/stream", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new Error("No hay conexión con Shiro. ¿Sigue abierta la consola donde lo iniciaste?");
	}
	if (!r.ok) {
		const j = await r.json().catch(() => ({}));
		throw new Error(j.error || `Error ${r.status}`);
	}
	const type = (r.headers.get("content-type") || "").toLowerCase();
	if (!type.includes("text/event-stream")) {
		const j = await r.json();
		if (j.error) throw new Error(j.error);
		if (j.room !== undefined) handlers.onRoom?.({ room: j.room, openVoice: j.openVoice });
		handlers.onDone?.({ content: j.content || "", whatsapp: j.whatsapp, agent: j.agent });
		return;
	}
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let full = "";
	let finished = false;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let sep;
		while ((sep = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, sep);
			buf = buf.slice(sep + 2);
			for (const line of block.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				if (evt.type === "delta" && evt.text) {
					full += evt.text;
					handlers.onDelta?.(full, evt.text);
				} else if (evt.type === "tool") {
					handlers.onTool?.(evt);
				} else if (evt.type === "approval") {
					handlers.onApproval?.(evt);
				} else if (evt.type === "agent") {
					handlers.onAgent?.(evt.agent);
				} else if (evt.type === "room") {
					handlers.onRoom?.(evt);
				} else if (evt.type === "done") {
					finished = true;
					handlers.onDone?.({ content: evt.content ?? full, whatsapp: evt.whatsapp, agent: evt.agent });
				} else if (evt.type === "error") {
					throw new Error(evt.message || "Error en la respuesta");
				}
			}
		}
	}
	if (!finished && !signal?.aborted) {
		// El servidor cortó sin terminar: se conserva lo recibido.
		handlers.onDone?.({ content: full, incomplete: true });
	}
}

/** Escucha un flujo de eventos del servidor (SSE) hasta que se corte o se cancele. */
export async function streamEvents(url, onEvent, signal) {
	const r = await authFetch(url, { headers: { Accept: "text/event-stream" }, signal });
	if (!r.ok) throw new Error(`Error ${r.status}`);
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) return;
		buf += dec.decode(value, { stream: true });
		let sep;
		while ((sep = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, sep);
			buf = buf.slice(sep + 2);
			for (const line of block.split("\n")) {
				if (!line.startsWith("data: ")) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				onEvent(evt);
			}
		}
	}
}

/** Responde a una petición de permiso. */
export function answerApproval(id, approved, remember = false) {
	return api("/api/approvals/" + encodeURIComponent(id), { method: "POST", json: { approved, remember } });
}

/** Carga una imagen protegida (capturas) como URL local. */
const blobCache = new Map();
export async function protectedImageUrl(url) {
	if (!url.startsWith("/api/")) return url;
	if (blobCache.has(url)) return blobCache.get(url);
	const r = await authFetch(url);
	if (!r.ok) throw new Error("No se pudo cargar la imagen");
	const obj = URL.createObjectURL(await r.blob());
	blobCache.set(url, obj);
	return obj;
}
