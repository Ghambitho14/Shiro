/**
 * Nunca dos modelos cargados a la vez en este equipo (cada agente de una sala puede tener el suyo).
 *
 * Cada vuelta con un modelo local pasa por aquí (`acquireModel` → vuelta → `release`):
 * - Mismo modelo que el actual: pasan varias a la vez (la web y Telegram, por ejemplo).
 * - Otro modelo: espera a que terminen las vueltas en curso, descarga el anterior y sigue.
 * - La primera vez se descarga lo que haya cargado en ese servidor (lo dejó otro programa o un Shiro anterior).
 * Los de la nube o los servidores que maneja el usuario (vLLM, llama-server propio…) no esperan.
 */
import { logger } from "../logger.js";
import { stopLlamaServer } from "../llamacpp/engine.js";
import { LLMError } from "./LLMClient.js";
import type { LLMSettings } from "./providers.js";

export type GateTarget = {
	key: string;
	provider: string;
	model: string;
	baseUrl: string;
	/** Para hablar con el servidor al descargar (la clave de LM Studio, si tiene). */
	headers?: Record<string, string>;
};

/** Proveedores en los que Shiro sabe descargar el modelo anterior (o los mantiene él). */
const GATED = new Set(["ollama", "lmstudio", "gguf"]);

export function gateTarget(s: Pick<LLMSettings, "provider" | "model" | "baseUrl"> & { headers?: Record<string, string> }): GateTarget | null {
	if (!GATED.has(s.provider)) return null;
	// llama.cpp integrado: la dirección cambia en cada arranque, el modelo es lo que cuenta.
	const where = s.provider === "gguf" ? "" : s.baseUrl;
	return { key: `${s.provider}|${where}|${s.model}`, provider: s.provider, model: s.model, baseUrl: s.baseUrl, headers: s.headers };
}

/**
 * Descarga en el servidor de `server` todos los modelos menos `keep` (si `keep` está en ese mismo servidor).
 * Se llama con el modelo anterior al cambiar, y con el nuevo (server = keep) la primera vez.
 */
type Unloader = (server: GateTarget, keep: GateTarget) => Promise<string[]>;

const sameServer = (a: GateTarget, b: GateTarget) => a.provider === b.provider && a.baseUrl === b.baseUrl;

async function unloadOllama(server: GateTarget, keep: GateTarget): Promise<string[]> {
	const res = await fetch(`${server.baseUrl}/api/ps`, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`Ollama respondió ${res.status}`);
	const data = (await res.json()) as { models?: { name?: string; model?: string }[] };
	const loaded = (data.models ?? []).map((m) => m.name || m.model || "").filter(Boolean);
	const drop = loaded.filter((name) => !(sameServer(server, keep) && name === keep.model));
	for (const model of drop) {
		const r = await fetch(`${server.baseUrl}/api/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, keep_alive: 0 }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!r.ok && r.status !== 404) throw new Error(`Ollama no descargó ${model}: ${r.status}`);
	}
	return drop;
}

/**
 * LM Studio (0.4+): su API /api/v1/models dice qué está cargado y /api/v1/models/unload lo descarga.
 * El siguiente modelo lo carga LM Studio solo al pedirlo (carga "JIT").
 */
async function unloadLmStudio(server: GateTarget, keep: GateTarget): Promise<string[]> {
	const root = server.baseUrl.replace(/\/v1$/i, "");
	const headers = { "Content-Type": "application/json", ...(server.headers?.Authorization ? { Authorization: server.headers.Authorization } : {}) };
	const res = await fetch(`${root}/api/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
	// Un LM Studio viejo sin esta API: con «mantener solo el último modelo» descarga el anterior él solo.
	if (res.status === 404) return [];
	if (!res.ok) throw new Error(`LM Studio respondió ${res.status}`);
	const data = (await res.json()) as { models?: { key?: string; loaded_instances?: { id?: string }[] }[] };
	const keepHere = sameServer(server, keep);
	const drop = (data.models ?? [])
		.filter((m) => !(keepHere && (m.key === keep.model || m.loaded_instances?.some((i) => i.id === keep.model))))
		.flatMap((m) => m.loaded_instances ?? [])
		.map((i) => i.id ?? "")
		.filter(Boolean);
	for (const id of drop) {
		const r = await fetch(`${root}/api/v1/models/unload`, {
			method: "POST",
			headers,
			body: JSON.stringify({ instance_id: id }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!r.ok) throw new Error(`LM Studio no descargó ${id}: ${r.status}`);
	}
	return drop;
}

const defaultUnloaders: Record<string, Unloader> = {
	ollama: unloadOllama,
	lmstudio: unloadLmStudio,
	// De GGUF a GGUF ya lo cambia el motor; a cualquier otro, se cierra para liberar la GPU.
	gguf: async (server, keep) => {
		if (keep.provider === "gguf") return [];
		return (await stopLlamaServer()) ? [server.model] : [];
	},
};

let unloaders: Record<string, Unloader> = defaultUnloaders;

/** Solo para pruebas: cambia cómo se descarga cada proveedor (null = los de verdad). */
export function setUnloadersForTests(u: Record<string, Unloader> | null): void {
	unloaders = u ?? defaultUnloaders;
}

type Waiter = { target: GateTarget; resolve: () => void };

let current: GateTarget | null = null;
let active = 0;
let switching = false;
const queue: Waiter[] = [];

/** Solo para pruebas: olvida el modelo actual. */
export function resetModelGateForTests(): void {
	current = null;
	active = 0;
	switching = false;
	queue.length = 0;
}

export function currentGatedModel(): GateTarget | null {
	return current;
}

function admitSameModel(): void {
	if (!current) return;
	for (let i = 0; i < queue.length; ) {
		if (queue[i].target.key === current.key) {
			const [w] = queue.splice(i, 1);
			active++;
			w.resolve();
		} else i++;
	}
}

async function unload(server: GateTarget, keep: GateTarget): Promise<void> {
	const fn = unloaders[server.provider];
	if (!fn) return;
	try {
		const dropped = await fn(server, keep);
		if (dropped.length) logger.info(`Descargado ${dropped.join(", ")} para usar ${keep.model} (un modelo a la vez).`);
	} catch (err) {
		logger.warn(`No pude descargar el modelo anterior: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function pump(): Promise<void> {
	if (switching || active > 0 || !queue.length) return;
	const next = queue[0].target;
	if (!current || current.key !== next.key) {
		switching = true;
		try {
			if (current) await unload(current, next);
			// En su servidor puede haber otros cargados (el primer uso, u otro programa los cargó).
			if (!current || !sameServer(current, next)) await unload(next, next);
		} finally {
			switching = false;
		}
	}
	current = next;
	admitSameModel();
	// Si mientras se descargaba no quedó nadie para este modelo, sigue con el siguiente.
	if (active === 0 && queue.length) void pump();
}

/** Espera su turno para usar este modelo. Devuelve la función que lo suelta (llamarla siempre). */
export async function acquireModel(target: GateTarget | null, signal?: AbortSignal): Promise<() => void> {
	if (!target) return () => {};
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		active--;
		void pump();
	};
	if (!switching && !queue.length && current?.key === target.key) {
		active++;
		return release;
	}
	if (signal?.aborted) throw new LLMError("Respuesta detenida por el usuario.", "cancelled");
	await new Promise<void>((resolve, reject) => {
		const w: Waiter = { target, resolve };
		const onAbort = () => {
			const i = queue.indexOf(w);
			if (i >= 0) queue.splice(i, 1);
			reject(new LLMError("Respuesta detenida por el usuario.", "cancelled"));
			void pump();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		w.resolve = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		queue.push(w);
		void pump();
	});
	return release;
}
