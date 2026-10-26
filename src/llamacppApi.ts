/**
 * API de Ajustes → Modelo cuando el proveedor es "llama.cpp integrado (archivos GGUF)":
 * descargar llama.cpp, ver los modelos encontrados, carpetas, contexto y liberar la GPU.
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import { existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { getConfig, setConfig, type AppConfig } from "./config/config.js";
import { getEngineStatus, LOG_FILE, stopLlamaServer } from "./core/llamacpp/engine.js";
import { BACKEND_LABELS, detectNvidia, findDownload, getInstalled, getInstallState, installLlamaCpp, resolveTarget } from "./core/llamacpp/install.js";
import { listGgufModels, MODELS_DIR, SOURCE_LABELS } from "./core/llamacpp/models.js";
import { canPickFolder, pickFolder } from "./core/pc/pickFolder.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

const BACKENDS = ["auto", "cuda", "vulkan", "cpu"] as const;

async function buildStatus(req: IncomingMessage, fresh = false) {
	const cfg = getConfig();
	const installed = getInstalled();
	return {
		installed: installed ? { tag: installed.tag, backend: installed.backend, variant: installed.variant, label: BACKEND_LABELS[installed.backend], installedAt: installed.installedAt } : null,
		install: getInstallState(),
		backendChoice: cfg.llamaBackend,
		server: await getEngineStatus(),
		models: listGgufModels({ fresh }).map((m) => ({
			id: m.id,
			path: m.path,
			sizeBytes: m.sizeBytes,
			source: m.source,
			sourceLabel: SOURCE_LABELS[m.source],
			vision: Boolean(m.mmproj),
		})),
		modelsDir: MODELS_DIR,
		folders: cfg.ggufFolders,
		idleMinutes: cfg.llamaIdleMinutes,
		canPickFolder: canPickFolder(req),
		logFile: LOG_FILE,
	};
}

/** Qué se descargaría con la opción elegida (consulta GitHub; el resultado se guarda 30 min). */
async function downloadInfo(choice: AppConfig["llamaBackend"]) {
	const nvidia = await detectNvidia();
	try {
		const target = await resolveTarget(choice);
		const pick = await findDownload(target);
		return {
			backend: target.backend,
			label: BACKEND_LABELS[target.backend],
			variant: pick.variant,
			tag: pick.tag,
			sizeBytes: pick.main.size + (pick.extra?.size ?? 0),
			gpu: nvidia?.name ?? null,
		};
	} catch (err) {
		return { gpu: nvidia?.name ?? null, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function handleLlamaCppApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, { readJson, sendJson }: Helpers): Promise<boolean> {
	if (pathname !== "/api/llamacpp" && !pathname.startsWith("/api/llamacpp/")) return false;
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

	if (pathname === "/api/llamacpp" && method === "GET") {
		const fresh = new URL(req.url ?? "/", "http://x").searchParams.has("fresh");
		return reply(200, await buildStatus(req, fresh));
	}

	if (pathname === "/api/llamacpp" && method === "PUT") {
		const d = await body();
		if (!d) return fail(400, "JSON inválido");
		const patch: Partial<AppConfig> = {};
		if (Array.isArray(d.folders)) {
			const folders: string[] = [];
			for (const raw of d.folders) {
				if (typeof raw !== "string" || !raw.trim()) continue;
				const p = raw.trim();
				if (!isAbsolute(p)) return fail(400, `Escribe la ruta completa de la carpeta: ${p}`);
				const full = resolve(p);
				if (!existsSync(full) || !statSync(full).isDirectory()) return fail(400, `No existe la carpeta: ${full}`);
				if (!folders.some((f) => f.toLowerCase() === full.toLowerCase())) folders.push(full);
			}
			patch.ggufFolders = folders;
		}
		if (d.idleMinutes !== undefined) {
			const n = Number(d.idleMinutes);
			if (!Number.isInteger(n) || n < 0 || n > 1440) return fail(400, "Los minutos deben estar entre 0 (nunca) y 1440.");
			patch.llamaIdleMinutes = n;
		}
		if (d.backend !== undefined) {
			if (!BACKENDS.includes(d.backend as (typeof BACKENDS)[number])) return fail(400, "Versión de llama.cpp inválida.");
			patch.llamaBackend = d.backend as AppConfig["llamaBackend"];
		}
		setConfig(patch);
		return reply(200, await buildStatus(req, true));
	}

	if (pathname === "/api/llamacpp/download-info" && method === "GET") {
		const choice = new URL(req.url ?? "/", "http://x").searchParams.get("backend");
		return reply(200, await downloadInfo(BACKENDS.includes(choice as (typeof BACKENDS)[number]) ? (choice as AppConfig["llamaBackend"]) : getConfig().llamaBackend));
	}

	if (pathname === "/api/llamacpp/install" && method === "POST") {
		const d = (await body()) ?? {};
		if (d.backend !== undefined) {
			if (!BACKENDS.includes(d.backend as (typeof BACKENDS)[number])) return fail(400, "Versión de llama.cpp inválida.");
			setConfig({ llamaBackend: d.backend as AppConfig["llamaBackend"] });
		}
		// Sigue en segundo plano: la web consulta el progreso con GET /api/llamacpp.
		installLlamaCpp({
			beforeSwap: async () => {
				await stopLlamaServer();
			},
		}).catch(() => {
			// El error queda en getInstallState().
		});
		return reply(202, { ok: true, install: getInstallState() });
	}

	if (pathname === "/api/llamacpp/stop" && method === "POST") {
		return reply(200, { stopped: await stopLlamaServer() });
	}

	if (pathname === "/api/llamacpp/pick-folder" && method === "POST") {
		if (!canPickFolder(req)) return fail(400, "El selector de carpetas solo funciona con Shiro abierto en este mismo PC con Windows. Escribe la ruta.");
		try {
			const path = await pickFolder("Elige una carpeta con modelos GGUF");
			return reply(200, path ? { path } : { cancelled: true });
		} catch (err) {
			return fail(500, err);
		}
	}

	return fail(404, "No encontrado");
}
