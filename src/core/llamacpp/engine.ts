/**
 * El llama-server que abre Shiro para el proveedor "gguf": uno solo, con el modelo elegido.
 * - Al cambiar de modelo (o de contexto) se cierra y se abre con el nuevo.
 * - Con `--sleep-idle-seconds`, el propio llama.cpp suelta la memoria de la GPU tras un rato sin
 *   uso y vuelve a cargar el modelo con la siguiente petición.
 * - Escucha solo en 127.0.0.1 con una clave aleatoria (ninguna web abierta en el navegador puede usarlo).
 * - data/cache/llama-server.json permite que otro proceso de Shiro (terminal, Telegram, o el
 *   mismo tras reiniciarse) reutilice el servidor en vez de cargar el modelo dos veces.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { DATA_DIR, getConfig } from "../../config/config.js";
import { LLMError } from "../llm/LLMClient.js";
import { getModelTuning } from "../llm/modelSettings.js";
import { ENGINE_DIR, getInstalled } from "./install.js";
import type { GgufModel } from "./models.js";

const STATE_FILE = join(DATA_DIR, "cache", "llama-server.json");
export const LOG_FILE = join(ENGINE_DIR, "llama-server.log");
const LOAD_TIMEOUT_MS = 5 * 60_000;

type ServerInfo = {
	pid: number;
	port: number;
	apiKey: string;
	signature: string;
	modelId: string;
	modelPath: string;
	/** Contexto real con el que arrancó (en automático lo elige llama.cpp). */
	ctx: number;
	vision: boolean;
	/** Proceso de Shiro que lo cierra al salir. */
	ownerPid: number;
	startedAt: string;
};

/** Rendimiento (Ajustes → Modelo → Rendimiento). Sin valor = automático. */
export type PerfOptions = {
	gpuLayers?: "auto" | "all" | number;
	kvCache?: "f16" | "q8_0" | "q4_0";
	threads?: number;
	flashAttention?: "auto" | "on" | "off";
};

/** `ctx` 0 = automático. */
export type LaunchOptions = { exe: string; model: GgufModel; port: number; ctx: number; idleMinutes: number; vision: boolean } & PerfOptions;

/** En automático, llama.cpp no baja de aquí: antes deja parte del modelo en el procesador. */
const AUTO_MIN_CTX = 16_384;

/**
 * Argumentos de llama-server. Lo que está en automático no se pasa (capas en GPU, flash attention…).
 * Sin contexto fijo, `--fit` (activado por defecto) elige el mayor que quepa en la tarjeta.
 */
export function buildServerArgs(o: LaunchOptions): string[] {
	const ctx = o.ctx > 0 ? ["-c", String(o.ctx)] : ["--fit-ctx", String(AUTO_MIN_CTX)];
	const args = ["-m", o.model.path, "--host", "127.0.0.1", "--port", String(o.port), ...ctx, "-np", "1", "--alias", o.model.id, "--no-webui"];
	if (o.idleMinutes > 0) args.push("--sleep-idle-seconds", String(o.idleMinutes * 60));
	if (o.vision && o.model.mmproj) args.push("--mmproj", o.model.mmproj);
	if (o.gpuLayers !== undefined && o.gpuLayers !== "auto") args.push("-ngl", String(o.gpuLayers));
	// Memoria del contexto comprimida: cabe el doble (q8_0) o el cuádruple (q4_0) de contexto.
	if (o.kvCache && o.kvCache !== "f16") args.push("-ctk", o.kvCache, "-ctv", o.kvCache);
	if (o.threads && o.threads > 0) args.push("-t", String(o.threads));
	if (o.flashAttention && o.flashAttention !== "auto") args.push("-fa", o.flashAttention);
	return args;
}

/** Lo que obliga a reiniciar el servidor si cambia. */
const signatureOf = (o: Omit<LaunchOptions, "port">) =>
	JSON.stringify([
		o.exe,
		o.model.path,
		o.ctx,
		o.idleMinutes,
		o.vision ? (o.model.mmproj ?? "") : "",
		o.gpuLayers ?? "auto",
		o.kvCache ?? "f16",
		o.threads ?? 0,
		o.flashAttention ?? "auto",
	]);

let current: (ServerInfo & { proc?: ChildProcess; spawnError?: Error }) | null = null;

/** Las peticiones se atienden de una en una: nunca se abren dos servidores a la vez. */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = lock.then(fn, fn);
	lock = run.catch(() => {});
	return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function health(port: number): Promise<"ok" | "loading" | "down"> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
		return r.ok ? "ok" : r.status === 503 ? "loading" : "down";
	} catch {
		return "down";
	}
}

function readState(): ServerInfo | null {
	try {
		const s = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ServerInfo;
		return Number.isInteger(s.pid) && Number.isInteger(s.port) && typeof s.apiKey === "string" ? s : null;
	} catch {
		return null;
	}
}

function writeState(s: ServerInfo): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	const { pid, port, apiKey, signature, modelId, modelPath, ctx, vision, ownerPid, startedAt } = s;
	writeFileSync(STATE_FILE, JSON.stringify({ pid, port, apiKey, signature, modelId, modelPath, ctx, vision, ownerPid, startedAt }), "utf-8");
}

function clearState(pid?: number): void {
	const s = readState();
	if (!s || pid === undefined || s.pid === pid) rmSync(STATE_FILE, { force: true });
}

function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as AddressInfo).port;
			srv.close(() => res(port));
		});
	});
}

/** Variables de entorno sin claves ni tokens (llama-server no necesita ninguna de Shiro). */
function cleanEnv(apiKey: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) || k.startsWith("SHIRO_") || k.startsWith("LLAMA_")) continue;
		env[k] = v;
	}
	// La clave va por el entorno para que no se vea en la lista de procesos.
	env.LLAMA_API_KEY = apiKey;
	return env;
}

/** Últimas líneas del registro de llama-server. */
export function readLogTail(maxBytes = 16_384): string {
	let fd: number | undefined;
	try {
		const size = statSync(LOG_FILE).size;
		const len = Math.min(size, maxBytes);
		const buf = Buffer.alloc(len);
		fd = openSync(LOG_FILE, "r");
		readSync(fd, buf, 0, len, size - len);
		return buf.toString("utf-8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Traduce el motivo por el que llama-server no arrancó a algo que el usuario pueda resolver. */
export function explainFailure(log: string, ctx: { model: GgufModel; ctx: number; exitCode?: number | null; spawnError?: Error }): string {
	if (ctx.spawnError) return `No se pudo abrir llama-server (${ctx.spawnError.message}). Vuelve a descargarlo en Ajustes → Modelo.`;
	// STATUS_DLL_NOT_FOUND de Windows.
	if (ctx.exitCode === 3221225781 || /cudart|cublas|\.dll was not found|cannot open shared object|error while loading shared libraries/i.test(log)) {
		return "A llama.cpp le faltan librerías (de CUDA o de Windows). Vuelve a descargarlo en Ajustes → Modelo o elige la versión Vulkan.";
	}
	if (/unknown (model )?architecture|unsupported model architecture/i.test(log)) {
		return `Esta versión de llama.cpp no sabe usar el modelo "${ctx.model.id}". Pulsa «Actualizar» en Ajustes → Modelo o elige otro modelo.`;
	}
	if (/out of memory|failed to allocate|cudaMalloc failed|ErrorOutOfDeviceMemory|unable to allocate|not enough memory/i.test(log)) {
		return ctx.ctx > 0
			? `El modelo "${ctx.model.id}" no cabe en la memoria con un contexto de ${ctx.ctx} tokens. Pon el tamaño de contexto en Automático (Ajustes → Modelo) o usa una versión más pequeña (por ejemplo Q4_K_M).`
			: `El modelo "${ctx.model.id}" no cabe en la memoria de la tarjeta gráfica. Cierra programas que la usen (juegos, Ollama…) o usa una versión más pequeña (por ejemplo Q4_K_M).`;
	}
	if (/V cache quantization requires|quantized V cache.*flash|flash.?attn.*(required|requires)/i.test(log)) {
		return "La memoria del contexto comprimida necesita flash attention. En Ajustes → Modelo → Rendimiento pon «Flash attention» en Automático o Sí, o usa la memoria normal.";
	}
	if (/invalid magic|failed to read magic|not a gguf|unexpectedly reached end of file|failed to read tensor|corrupted/i.test(log)) {
		return `El archivo del modelo está dañado o incompleto: ${ctx.model.path}`;
	}
	const lines = log
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && /error|fail|unable|cannot|invalid/i.test(l))
		.slice(-4);
	return `llama.cpp no pudo cargar el modelo "${ctx.model.id}".${lines.length ? `\n${lines.join("\n")}` : ""}\n(Registro completo: ${LOG_FILE})`;
}

/** Espera a que el modelo esté cargado. Falla en cuanto el proceso se cierre. */
async function waitReady(info: ServerInfo & { proc?: ChildProcess; spawnError?: Error }, model: GgufModel): Promise<void> {
	const t0 = Date.now();
	while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
		const dead = info.proc ? info.proc.exitCode !== null || info.proc.signalCode !== null || Boolean(info.spawnError) : !alive(info.pid);
		if (dead) {
			if (current === info) current = null;
			clearState(info.pid);
			throw new LLMError(explainFailure(readLogTail(), { model, ctx: info.ctx, exitCode: info.proc?.exitCode, spawnError: info.spawnError }), "bad_request");
		}
		if ((await health(info.port)) === "ok") return;
		await sleep(400);
	}
	killServer(info);
	throw new LLMError(`llama.cpp tardó más de ${LOAD_TIMEOUT_MS / 60_000} minutos en cargar "${model.id}". Prueba con un modelo más pequeño.`, "bad_request");
}

function killServer(info: ServerInfo & { proc?: ChildProcess }): void {
	try {
		if (info.proc) info.proc.kill();
		else if (alive(info.pid)) process.kill(info.pid);
	} catch {
		// ya estaba cerrado
	}
	if (current === info) current = null;
	clearState(info.pid);
}

async function launch(exe: string, model: GgufModel, o: { ctx: number; idleMinutes: number; vision: boolean; signature: string } & PerfOptions): Promise<ServerInfo> {
	const port = await freePort();
	const apiKey = randomBytes(24).toString("hex");
	mkdirSync(ENGINE_DIR, { recursive: true });
	// El registro va a un archivo: así llama-server sigue bien aunque este proceso se cierre.
	const logFd = openSync(LOG_FILE, "w");
	let proc: ChildProcess;
	try {
		proc = spawn(exe, buildServerArgs({ exe, model, port, ...o }), {
			cwd: dirname(exe),
			env: cleanEnv(apiKey),
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
		});
	} finally {
		closeSync(logFd);
	}
	const info: ServerInfo & { proc?: ChildProcess; spawnError?: Error } = {
		pid: proc.pid ?? -1,
		port,
		apiKey,
		signature: o.signature,
		modelId: model.id,
		modelPath: model.path,
		ctx: o.ctx,
		vision: o.vision,
		ownerPid: process.pid,
		startedAt: new Date().toISOString(),
		proc,
	};
	// Que llama-server no impida terminar a un proceso corto (doctor, terminal): al salir, el
	// manejador de "exit" lo cierra igualmente.
	proc.unref();
	proc.on("error", (err) => (info.spawnError = err));
	proc.on("exit", () => {
		if (current === info) current = null;
		clearState(info.pid);
	});
	current = info;
	if (info.pid > 0) writeState(info);
	await waitReady(info, model);
	// En automático, el contexto lo eligió llama.cpp: se guarda el real.
	const real = await readServerCtx(info);
	if (real) {
		info.ctx = real;
		if (current === info) writeState(info);
	}
	return info;
}

/** Contexto con el que arrancó llama-server (de /props). */
async function readServerCtx(s: ServerInfo): Promise<number | undefined> {
	try {
		const r = await fetch(`http://127.0.0.1:${s.port}/props`, { headers: { Authorization: `Bearer ${s.apiKey}` }, signal: AbortSignal.timeout(3000) });
		if (!r.ok) return undefined;
		const j = (await r.json()) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
		const n = Number(j.default_generation_settings?.n_ctx ?? j.n_ctx);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

/** Usa el servidor que dejó otro proceso de Shiro si es el mismo modelo; si no, lo cierra. */
async function adoptOrClean(signature: string, model: GgufModel): Promise<ServerInfo | null> {
	const s = readState();
	if (!s) return null;
	if (!alive(s.pid) || (await health(s.port)) === "down") {
		// Proceso muerto (o el número ya es de otro programa): no se toca, solo se olvida.
		clearState(s.pid);
		return null;
	}
	if (s.signature === signature) {
		if (s.ownerPid === process.pid || !alive(s.ownerPid)) writeState({ ...s, ownerPid: process.pid });
		current = { ...s, ownerPid: alive(s.ownerPid) ? s.ownerPid : process.pid };
		await waitReady(current, model);
		return current;
	}
	killServer(s);
	await sleep(500);
	return null;
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) return Promise.reject(new LLMError("Respuesta detenida por el usuario.", "cancelled"));
	return new Promise((res, rej) => {
		const onAbort = () => rej(new LLMError("Respuesta detenida por el usuario.", "cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(res, rej).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/**
 * Deja llama-server listo con este modelo y devuelve cómo hablarle.
 * Si el usuario pulsa "Detener" mientras carga, se deja de esperar pero la carga sigue
 * (el siguiente mensaje ya lo encuentra listo).
 */
export function ensureLlamaServer(model: GgufModel, signal?: AbortSignal): Promise<{ baseUrl: string; apiKey: string }> {
	const installed = getInstalled();
	if (!installed) {
		return Promise.reject(new LLMError("llama.cpp todavía no está descargado. Descárgalo en Ajustes → Modelo (botón «Descargar llama.cpp»).", "bad_request"));
	}
	const cfg = getConfig();
	// Contexto y rendimiento: los de este modelo (Ajustes → Modelo) o los generales.
	const t = getModelTuning("gguf", model.id, cfg);
	const o = {
		ctx: t.contextSize,
		idleMinutes: cfg.llamaIdleMinutes,
		vision: cfg.vision !== "off" && Boolean(model.mmproj),
		gpuLayers: t.gpuLayers,
		kvCache: t.kvCache,
		threads: t.threads,
		flashAttention: t.flashAttention,
	};
	const signature = signatureOf({ exe: installed.exePath, model, ...o });
	const conn = (s: ServerInfo) => ({ baseUrl: `http://127.0.0.1:${s.port}/v1`, apiKey: s.apiKey });
	return abortable(
		exclusive(async () => {
			if (current && current.signature === signature) {
				const procDead = current.proc && (current.proc.exitCode !== null || current.proc.signalCode !== null);
				if (!procDead && (await health(current.port)) !== "down") {
					await waitReady(current, model);
					return conn(current);
				}
				killServer(current);
			} else if (current) {
				killServer(current);
				await sleep(500);
			}
			const adopted = await adoptOrClean(signature, model);
			if (adopted) return conn(adopted);
			return conn(await launch(installed.exePath, model, { ...o, signature }));
		}),
		signal,
	);
}

/** Cómo hablar con el servidor activo (para resolveLLMSettings, que es síncrona). */
export function currentLlamaServer(): { baseUrl: string; apiKey: string; ctx: number } | null {
	return current ? { baseUrl: `http://127.0.0.1:${current.port}/v1`, apiKey: current.apiKey, ctx: current.ctx } : null;
}

/** "Liberar la GPU ahora": cierra el servidor (aunque lo abriera otro proceso de Shiro). */
export async function stopLlamaServer(): Promise<boolean> {
	if (current) {
		killServer(current);
		return true;
	}
	const s = readState();
	if (!s) return false;
	// Solo se cierra si de verdad es un llama-server (responde en su puerto).
	if (alive(s.pid) && (await health(s.port)) !== "down") {
		killServer(s);
		return true;
	}
	clearState(s.pid);
	return false;
}

/** Al cerrar Shiro: cierra el servidor si es suyo (si lo abrió otro proceso de Shiro, lo deja). */
export function releaseLlamaServer(): void {
	if (current && (current.proc || current.ownerPid === process.pid)) killServer(current);
}

process.on("exit", releaseLlamaServer);

export type EngineStatus = {
	modelId: string;
	modelPath: string;
	port: number;
	ctx: number;
	vision: boolean;
	startedAt: string;
	/** El modelo está fuera de la memoria (se recarga solo con el siguiente mensaje). */
	sleeping: boolean;
	loading: boolean;
} | null;

/** Estado del servidor para Ajustes (también si lo abrió otro proceso de Shiro). */
export async function getEngineStatus(): Promise<EngineStatus> {
	const s = current ?? readState();
	if (!s || !alive(s.pid)) return null;
	const h = await health(s.port);
	if (h === "down") return null;
	let sleeping = false;
	if (h === "ok") {
		try {
			const r = await fetch(`http://127.0.0.1:${s.port}/props`, { headers: { Authorization: `Bearer ${s.apiKey}` }, signal: AbortSignal.timeout(2000) });
			sleeping = r.ok && Boolean(((await r.json()) as { is_sleeping?: boolean }).is_sleeping);
		} catch {
			// sin dato
		}
	}
	return { modelId: s.modelId, modelPath: s.modelPath, port: s.port, ctx: s.ctx, vision: s.vision, startedAt: s.startedAt, sleeping, loading: h === "loading" };
}
