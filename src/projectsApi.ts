/**
 * API de los Proyectos de la web (barra lateral → Proyectos).
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_DOCUMENT_BYTES } from "./core/projects/documents.js";
import {
	addFolder,
	attachChat,
	createProject,
	deleteProject,
	detachChat,
	getProject,
	listProjects,
	listUploadsTop,
	projectSources,
	removeFolder,
	removeUpload,
	saveUpload,
	updateProject,
	type Project,
} from "./core/projects/projects.js";
import { canPickFolder, pickFolder } from "./core/pc/pickFolder.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

/** Resumen para la lista de la barra lateral. */
const summary = (p: Project) => ({ id: p.id, name: p.name, description: p.description, chats: p.chats, createdAt: p.createdAt, updatedAt: p.updatedAt });

/** Proyecto completo para su página: instrucciones, carpetas vinculadas y archivos subidos. */
function detail(p: Project) {
	const sources = projectSources(p);
	return {
		...summary(p),
		instructions: p.instructions,
		folders: sources.filter((s) => s.kind === "folder").map((s) => ({ path: s.root, label: s.label, exists: s.exists })),
		uploads: listUploadsTop(p.id),
	};
}

export async function handleProjectsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, { readJson, sendJson }: Helpers): Promise<boolean> {
	if (!pathname.startsWith("/api/projects")) return false;
	const reply = (status: number, data: object) => {
		sendJson(res, status, data);
		return true;
	};
	const fail = (status: number, err: unknown) => reply(status, { error: err instanceof Error ? err.message : String(err) });
	const body = async () => {
		try {
			return await readJson<Record<string, unknown>>(req);
		} catch {
			return null;
		}
	};

	if (pathname === "/api/projects") {
		if (method === "GET") {
			return reply(200, { projects: listProjects().map(summary), canPickFolder: canPickFolder(req) });
		}
		if (method === "POST") {
			const d = await body();
			if (!d) return fail(400, "JSON inválido");
			try {
				return reply(201, { project: detail(createProject(d)) });
			} catch (err) {
				return fail(400, err);
			}
		}
	}

	if (pathname === "/api/projects/pick-folder" && method === "POST") {
		if (!canPickFolder(req)) return fail(400, "El selector de carpetas solo funciona con Shiro abierto en este mismo PC con Windows. Escribe la ruta.");
		try {
			const path = await pickFolder("Elige la carpeta para el proyecto");
			return reply(200, path ? { path } : { cancelled: true });
		} catch (err) {
			return fail(500, err);
		}
	}

	const m = /^\/api\/projects\/([\w-]{1,64})(?:\/(folders|files|chats))?$/.exec(pathname);
	if (!m) return fail(404, "No encontrado");
	const [, id, sub] = m as unknown as [string, string, string | undefined];
	if (!getProject(id)) return fail(404, "No encontré el proyecto.");

	try {
		if (!sub) {
			if (method === "GET") return reply(200, { project: detail(getProject(id)!) });
			if (method === "PATCH") {
				const d = await body();
				if (!d) return fail(400, "JSON inválido");
				return reply(200, { project: detail(updateProject(id, d)!) });
			}
			if (method === "DELETE") return reply(200, { ok: deleteProject(id) });
		}

		if (sub === "folders" && (method === "POST" || method === "DELETE")) {
			const d = await body();
			const path = typeof d?.path === "string" ? d.path : "";
			const p = method === "POST" ? addFolder(id, path) : removeFolder(id, path);
			return reply(200, { project: detail(p!) });
		}

		if (sub === "files") {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (method === "PUT") {
				const rel = url.searchParams.get("path") ?? "";
				const declared = Number(req.headers["content-length"] ?? 0);
				if (declared > MAX_DOCUMENT_BYTES) {
					req.resume();
					return fail(413, `${rel.split("/").pop()} es demasiado grande (máx. 25 MB).`);
				}
				const data = await readBuffer(req, MAX_DOCUMENT_BYTES);
				const saved = saveUpload(id, rel, data);
				return reply(200, { path: saved });
			}
			if (method === "DELETE") {
				const d = await body();
				const ok = removeUpload(id, typeof d?.path === "string" ? d.path : "");
				if (!ok) return fail(404, "No encontré ese archivo.");
				return reply(200, { project: detail(getProject(id)!) });
			}
		}

		if (sub === "chats" && (method === "POST" || method === "DELETE")) {
			const d = await body();
			const chatId = typeof d?.chatId === "string" ? d.chatId.trim() : "";
			if (!chatId) return fail(400, "Falta chatId");
			const p = method === "POST" ? attachChat(id, chatId) : detachChat(id, chatId);
			return reply(200, { project: summary(p!) });
		}
	} catch (err) {
		return fail(400, err);
	}

	return fail(405, "Método no permitido");
}

function readBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.byteLength;
			if (total > maxBytes) {
				req.destroy();
				reject(new Error("El archivo es demasiado grande (máx. 25 MB)."));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
