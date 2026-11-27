/**
 * Voz de Liquid (LFM3-Audio de Liquid AI) sin internet: oír (`/v1/audio/transcriptions`) y hablar
 * (`/v1/audio/speech`) con un llama-server aparte del que usa el chat (core/llamacpp/engine.ts), así
 * el modelo del chat no tiene que descargarse en cada frase.
 * - El modelo son dos archivos en una carpeta de data/models: `LFM3-Audio-…gguf` y su `mmproj`.
 * - Se abre al usarlo (o al arrancar Aku si está elegido en Ajustes → Voz) y queda cargado mientras
 *   Aku esté abierto: una frase tarda 1-2 s y recargarlo añadiría otros 5.
 * - Escucha solo en 127.0.0.1 con una clave aleatoria, como el del chat. Registro en
 *   data/llama.cpp/liquid-voice.log.
 * - Entiende WAV y MP3 (no webm): la web convierte lo grabado a WAV antes de mandarlo.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { getConfig } from "../../config/config.js";
import { ENGINE_DIR, getInstalled } from "../llamacpp/install.js";
import { MODELS_DIR } from "../llamacpp/models.js";

export const LIQUID_LOG = join(ENGINE_DIR, "liquid-voice.log");
const LOAD_TIMEOUT_MS = 3 * 60_000;
/** Contexto: ~16 tokens por segundo de audio; 8.192 da para más de 90 s de dictado. */
const CTX = 8192;

export type LiquidModel = { path: string; mmproj: string; name: string; sizeBytes: number };

/** Es un modelo de voz de Liquid (no su proyector de audio). */
export const isLiquidAudioFile = (name: string) => /^LFM\d*(\.\d+)?-Audio.*\.gguf$/i.test(name) && !/mmproj/i.test(name);

/** Elige el modelo de una lista de archivos de una carpeta: prefiere Q8_0, luego el más grande. */
export function pickLiquidFiles(files: { name: string; size: number }[]): { model: string; mmproj: string } | null {
	const models = files.filter((f) => isLiquidAudioFile(f.name));
	const projs = files.filter((f) => /mmproj/i.test(f.name) && /audio/i.test(f.name) && f.name.toLowerCase().endsWith(".gguf"));
	if (!models.length || !projs.length) return null;
	const q8 = (n: string) => /q8_0/i.test(n);
	const best = <T extends { name: string; size: number }>(list: T[]) => [...list].sort((a, b) => Number(q8(b.name)) - Number(q8(a.name)) || b.size - a.size)[0];
	return { model: best(models).name, mmproj: best(projs).name };
}

/** Busca el modelo en data/models (en la carpeta raíz y un nivel por debajo). */
export function findLiquidModel(root = MODELS_DIR): LiquidModel | null {
	const dirs = [root];
	try {
		for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) dirs.push(join(root, e.name));
	} catch {
		return null;
	}
	for (const dir of dirs) {
		let files: { name: string; size: number }[];
		try {
			files = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"))
				.map((e) => ({ name: e.name, size: statSync(join(dir, e.name)).size }));
		} catch {
			continue;
		}
		const pick = pickLiquidFiles(files);
		if (pick) {
			const path = join(dir, pick.model);
			return { path, mmproj: join(dir, pick.mmproj), name: pick.model.replace(/\.gguf$/i, ""), sizeBytes: statSync(path).size };
		}
	}
	return null;
}

/** Argumentos de llama-server para la voz (sin dormir: queda cargado mientras Aku esté abierto). */
export function buildLiquidArgs(o: { model: LiquidModel; port: number; lang: string }): string[] {
	return ["-m", o.model.path, "--mmproj", o.model.mmproj, "--host", "127.0.0.1", "--port", String(o.port), "-c", String(CTX), "-np", "1", "--alias", "liquid-voice", "--no-webui", "--tts-lang", o.lang];
}

/** Idioma de la voz (ISO 639-1) a partir del de la web ("es-CL" → "es"). */
export const langCode = (lang: string | undefined) => {
	const l = (lang || "es").slice(0, 2).toLowerCase();
	return /^[a-z]{2}$/.test(l) ? l : "es";
};

type Running = { proc: ChildProcess; port: number; apiKey: string; modelPath: string; lang: string; ready: boolean; error?: string };
let current: Running | null = null;
let lastError = "";

let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = lock.then(fn, fn);
	lock = run.catch(() => {});
	return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Entorno sin claves de Aku; la del servidor va por variable para que no se vea en la lista de procesos. */
function cleanEnv(apiKey: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) || k.startsWith("SHIRO_") || k.startsWith("LLAMA_")) continue;
		env[k] = v;
	}
	env.LLAMA_API_KEY = apiKey;
	return env;
}

function logTail(): string {
	try {
		const text = readFileSync(LIQUID_LOG, "utf-8");
		return text
			.split(/\r?\n/)
			.filter((l) => /error|fail|unable|cannot|invalid|out of memory/i.test(l))
			.slice(-3)
			.join("\n");
	} catch {
		return "";
	}
}

function explain(r: Running): string {
	const log = logTail();
	if (/out of memory|failed to allocate|cudaMalloc/i.test(log)) {
		return "La voz de Liquid no cabe en la memoria de la tarjeta gráfica. Cierra programas que la usen o libera el modelo del chat en Ajustes → Modelo.";
	}
	if (/unknown (model )?architecture|unsupported/i.test(log)) {
		return "Esta versión de llama.cpp no sabe usar LFM3-Audio. Actualízala en Ajustes → Modelo («Actualizar»).";
	}
	return `No se pudo abrir la voz de Liquid (código ${r.proc.exitCode ?? "?"}).${log ? `\n${log}` : ""}\n(Registro: ${LIQUID_LOG})`;
}

function stopCurrent(): void {
	if (!current) return;
	try {
		current.proc.kill();
	} catch {
		// ya estaba cerrado
	}
	current = null;
}

async function health(port: number): Promise<boolean> {
	try {
		return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
	} catch {
		return false;
	}
}

/** Deja el servidor de voz listo y devuelve cómo hablarle. */
export function ensureLiquidServer(lang = "es"): Promise<{ baseUrl: string; apiKey: string }> {
	return exclusive(async () => {
		const model = findLiquidModel();
		if (!model) {
			throw new Error("No encuentro el modelo de voz de Liquid. Pon LFM3-Audio-2B (el .gguf y su mmproj) en una carpeta de data/models.");
		}
		const installed = getInstalled();
		if (!installed) throw new Error("llama.cpp todavía no está descargado. Descárgalo en Ajustes → Modelo.");
		const code = langCode(lang);
		const conn = (r: Running) => ({ baseUrl: `http://127.0.0.1:${r.port}/v1`, apiKey: r.apiKey });
		if (current && current.modelPath === model.path && current.lang === code && current.proc.exitCode === null) {
			if (current.ready && (await health(current.port))) return conn(current);
		}
		stopCurrent();

		const port = await freePort();
		const apiKey = randomBytes(24).toString("hex");
		mkdirSync(ENGINE_DIR, { recursive: true });
		const logFd = openSync(LIQUID_LOG, "w");
		let proc: ChildProcess;
		try {
			proc = spawn(installed.exePath, buildLiquidArgs({ model, port, lang: code }), {
				cwd: dirname(installed.exePath),
				env: cleanEnv(apiKey),
				stdio: ["ignore", logFd, logFd],
				windowsHide: true,
			});
		} finally {
			closeSync(logFd);
		}
		const run: Running = { proc, port, apiKey, modelPath: model.path, lang: code, ready: false };
		proc.unref();
		proc.on("error", (err) => (run.error = err.message));
		proc.on("exit", () => {
			if (current === run) current = null;
		});
		current = run;

		const t0 = Date.now();
		while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
			if (run.error) {
				current = null;
				throw new Error(`No se pudo abrir llama-server (${run.error}). Vuelve a descargarlo en Ajustes → Modelo.`);
			}
			if (proc.exitCode !== null || proc.signalCode !== null) {
				current = null;
				throw new Error(explain(run));
			}
			if (await health(port)) {
				run.ready = true;
				lastError = "";
				return conn(run);
			}
			await sleep(400);
		}
		stopCurrent();
		throw new Error("La voz de Liquid tardó demasiado en cargar.");
	}).catch((err) => {
		lastError = err instanceof Error ? err.message : String(err);
		throw err;
	});
}

/** Pasa audio (WAV o MP3) a texto. */
export async function liquidTranscribe(audio: Buffer, mime: string, lang: string): Promise<string> {
	const { baseUrl, apiKey } = await ensureLiquidServer(getConfig().wakeLanguage);
	const ext = mime.includes("mpeg") ? "mp3" : "wav";
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${ext}`);
	form.append("model", "liquid-voice");
	form.append("language", langCode(lang));
	form.append("response_format", "json");
	const r = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(90_000) });
	if (!r.ok) {
		const msg = (await r.text().catch(() => "")).slice(0, 200);
		if (/Failed to load image or audio/i.test(msg)) throw new Error("La voz de Liquid no entiende ese formato de audio (usa WAV o MP3).");
		throw new Error(`La voz de Liquid falló al escuchar: ${r.status} ${msg}`);
	}
	const j = (await r.json()) as { text?: string };
	return (j.text ?? "").trim();
}

/** Texto a voz: devuelve un WAV. */
export async function liquidSpeak(text: string, voice: "female" | "male"): Promise<Buffer> {
	const { baseUrl, apiKey } = await ensureLiquidServer(getConfig().wakeLanguage);
	const r = await fetch(`${baseUrl}/audio/speech`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: "liquid-voice", input: text, voice, response_format: "wav" }),
		signal: AbortSignal.timeout(120_000),
	});
	if (!r.ok) throw new Error(`La voz de Liquid falló al hablar: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
	return Buffer.from(await r.arrayBuffer());
}

/** Si Ajustes → Voz usa Liquid, lo deja cargado (al arrancar Aku y al guardar Ajustes). */
export function warmLiquidVoice(): void {
	const cfg = getConfig();
	if (cfg.sttEngine !== "liquid" && cfg.ttsEngine !== "liquid") return;
	ensureLiquidServer(cfg.wakeLanguage).catch(() => {});
}

/** Para Ajustes → Voz. */
export function liquidStatus(): { installed: boolean; model?: string; sizeBytes?: number; running: boolean; error?: string } {
	const model = findLiquidModel();
	return {
		installed: Boolean(model && existsSync(model.mmproj)),
		...(model ? { model: model.name, sizeBytes: model.sizeBytes } : {}),
		running: Boolean(current?.ready),
		...(lastError ? { error: lastError } : {}),
	};
}

process.on("exit", stopCurrent);
