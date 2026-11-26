/**
 * Modo asistente (como Alexa): mientras Aku está encendido con su ícono en la bandeja (`npm run app` o Aku.exe),
 * escucha el micrófono sin internet y, si una frase empieza por «Aku» (`callsWake`), app.ts abre la cajita de
 * voz, que dice «Dígame».
 *
 * Cómo escucha: el ayudante nativo (`ShiroPc.Mic` en nativeHelper.ts, un PowerShell oculto) manda el sonido
 * crudo; el detector de voz Silero lo corta en frases y Moonshine en español pasa a texto solo el principio de
 * cada una (con sherpa-onnx, los dos modelos de `wakeModels.ts`, que se bajan la primera vez). Nada se guarda
 * ni sale del equipo; al registro solo va cuando llama a Aku. Antes se usaba el reconocedor de voz de Windows,
 * pero con un nombre inventado como «Aku» casi no acertaba y se trababa.
 *
 * Se enciende con `wakeWordEnabled` (Ajustes → Voz → Modo asistente); `syncWakeListener()` lo arranca, lo
 * para o lo reinicia si cambió la palabra o la sensibilidad. Si el micrófono se cae, se vuelve a abrir (como
 * mucho 5 veces seguidas).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getConfig } from "../../config/config.js";
import { logger } from "../logger.js";
import { ensureNativeHelper } from "../pc/powershell.js";
import { loadSherpa, type OfflineRecognizerInstance, type VadInstance } from "../voice/sherpaLoader.js";
import { asrDir, ASR_PACK, ensureWakeModels, vadPath, WAKE_DOWNLOAD_MB, wakeDownloadProgress, wakeModelsReady } from "./wakeModels.js";
import { callsWake, type WakeSensitivity } from "./wakeWord.js";

const RATE = 16000;
/** Muestras que el detector de voz espera de cada vez. */
const WINDOW = 512;
/** Solo se pasa a texto el principio de cada frase: ahí tiene que estar «Aku». */
const HEAD_SECONDS = 3;
/** Silencio que se añade alrededor de la frase: Moonshine acierta más con «Aku» suelto. */
const PAD = Math.round(RATE * 0.25);
/** Si el micrófono manda puro cero tanto tiempo, Windows no lo deja usar (privacidad). */
const SILENT_LIMIT_MS = 15_000;

export type WakeState = {
	state: "off" | "downloading" | "starting" | "listening" | "error";
	message?: string;
	/** Durante la descarga de los modelos: cuánto va (0 a 1). */
	progress?: number;
};

let handler: (() => void) | null = null;
let mic: ChildProcess | null = null;
let runningKey = "";
let status: WakeState = { state: "off" };
let restarts = 0;
let restartTimer: NodeJS.Timeout | null = null;
let lastWake = 0;
/** Sube cada vez que se para: lo que estaba arrancando con un número viejo se descarta. */
let generation = 0;
let recognizer: OfflineRecognizerInstance | null = null;

/** Lo que dice el error, en palabras del usuario. */
export function explainWakeError(raw: string): string {
	const t = raw.trim();
	if (/^mic (2|6)$/.test(t)) return "No encuentro un micrófono. Conecta uno o elígelo en Windows: Configuración → Sistema → Sonido → Entrada.";
	if (/^mic 4$/.test(t)) return "Otro programa tiene el micrófono tomado. Ciérralo y vuelve a encender el modo asistente.";
	if (/^mic /.test(t) || /^silencio$/.test(t)) {
		return "No me llega sonido del micrófono. Revisa en Windows: Configuración → Privacidad y seguridad → Micrófono → «Permitir que las aplicaciones de escritorio accedan al micrófono», y que el micrófono elegido sea el correcto.";
	}
	return t || "El micrófono se cerró sin decir por qué.";
}

/** Variables de entorno sin claves (el micrófono no necesita ninguna). */
function micEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) env[k] = v;
	for (const [k, v] of Object.entries(extra)) env[`SHIRO_A_${k.toUpperCase()}`] = v;
	return env;
}

function configKey(): string {
	const c = getConfig();
	return `${c.wakeWord}|${c.wakeSensitivity}`;
}

function stop(): void {
	generation++;
	if (restartTimer) clearTimeout(restartTimer);
	restartTimer = null;
	const m = mic;
	mic = null;
	runningKey = "";
	m?.kill();
}

/** Más sensible = el detector de voz corta con menos volumen (oye más bajito, y también más ruido). */
function vadThreshold(s: WakeSensitivity): number {
	return s === "high" ? 0.4 : s === "low" ? 0.6 : 0.5;
}

async function loadRecognizer(): Promise<OfflineRecognizerInstance> {
	if (recognizer) return recognizer;
	const dir = asrDir();
	recognizer = await loadSherpa().OfflineRecognizer.createAsync({
		featConfig: { sampleRate: RATE, featureDim: 80 },
		modelConfig: {
			moonshine: { encoder: join(dir, "encoder_model.ort"), mergedDecoder: join(dir, "decoder_model_merged.ort") },
			tokens: join(dir, "tokens.txt"),
			numThreads: 2,
			provider: "cpu",
			debug: 0,
		},
	});
	return recognizer;
}

function fail(message: string): void {
	status = { state: "error", message };
	logger.warn(`🎙️ Modo asistente: ${message}`);
}

async function start(): Promise<void> {
	const gen = generation;
	const c = getConfig();
	runningKey = configKey();
	try {
		if (!wakeModelsReady()) {
			status = { state: "downloading", message: `Bajando el oído de Aku (${WAKE_DOWNLOAD_MB} MB, solo esta vez)…`, progress: 0 };
			await ensureWakeModels();
			if (gen !== generation) return;
		}
		status = { state: "starting" };
		const rec = await loadRecognizer();
		const vad = loadSherpa().Vad
			? new (loadSherpa().Vad)(
					{
						sileroVad: { model: vadPath(), threshold: vadThreshold(c.wakeSensitivity), minSilenceDuration: 0.3, minSpeechDuration: 0.15, maxSpeechDuration: 8, windowSize: WINDOW },
						sampleRate: RATE,
						numThreads: 1,
						provider: "cpu",
						debug: 0,
					},
					30,
				)
			: null;
		if (!vad) throw new Error("Esta versión de sherpa-onnx no trae el detector de voz.");
		const dll = await ensureNativeHelper();
		if (gen !== generation) return;
		listen(gen, rec, vad, dll, c.wakeWord, c.wakeSensitivity);
	} catch (err) {
		if (gen !== generation) return;
		runningKey = "";
		fail(`no pude prepararlo: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function listen(gen: number, rec: OfflineRecognizerInstance, vad: VadInstance, dll: string, word: string, sensitivity: WakeSensitivity): void {
	const proc = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", "Add-Type -Path $env:SHIRO_A_HELPERDLL; exit [ShiroPc.Mic]::Stream([int]$env:SHIRO_A_PARENT)"],
		{ env: micEnv({ helperdll: dll, parent: String(process.pid) }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
	);
	mic = proc;
	const current = () => gen === generation && mic === proc;

	// El sonido llega en bytes (16 bits); el detector quiere trozos de 512 muestras.
	let odd: Buffer | null = null;
	const window = new Float32Array(WINDOW);
	let filled = 0;
	let silentSince = Date.now();
	let busy = false;
	let waiting: Float32Array | null = null;

	const transcribe = async (segment: Float32Array) => {
		busy = true;
		try {
			const head = segment.subarray(0, RATE * HEAD_SECONDS);
			const padded = new Float32Array(head.length + PAD * 2);
			padded.set(head, PAD);
			const stream = rec.createStream();
			stream.acceptWaveform({ samples: padded, sampleRate: RATE });
			const text = (await rec.decodeAsync(stream)).text.trim();
			if (!current() || !text || !callsWake(text, word, sensitivity)) return;
			if (Date.now() - lastWake < 4000) return;
			lastWake = Date.now();
			logger.info(`🎙️ Oí «${text.slice(0, 60)}»: abro la voz`);
			handler?.();
		} catch (err) {
			logger.warn(`🎙️ No pude pasar a texto lo que oí: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			busy = false;
			// Mientras pasaba una frase a texto llegó otra: se hace solo la última.
			const next = waiting;
			waiting = null;
			if (next && current()) void transcribe(next);
		}
	};

	proc.stdout?.on("data", (chunk: Buffer) => {
		if (!current()) return;
		let data = odd ? Buffer.concat([odd, chunk]) : chunk;
		odd = data.length % 2 ? data.subarray(data.length - 1) : null;
		if (odd) data = data.subarray(0, data.length - 1);
		let loud = false;
		for (let i = 0; i < data.length; i += 2) {
			const v = data.readInt16LE(i);
			if (v !== 0) loud = true;
			window[filled++] = v / 32768;
			if (filled === WINDOW) {
				vad.acceptWaveform(window);
				filled = 0;
				while (!vad.isEmpty()) {
					const seg = vad.front().samples.slice();
					vad.pop();
					if (busy) waiting = seg;
					else void transcribe(seg);
				}
			}
		}
		if (loud) {
			silentSince = Date.now();
			if (status.state !== "listening") {
				status = { state: "listening" };
				restarts = 0;
			}
		} else if (Date.now() - silentSince > SILENT_LIMIT_MS && status.state !== "error") {
			fail(explainWakeError("silencio"));
		}
	});
	let errors = "";
	proc.stderr?.setEncoding("utf8");
	proc.stderr?.on("data", (d: string) => (errors = (errors + d).slice(-500)));
	proc.on("error", (err) => {
		if (current()) fail(`No pude abrir el micrófono: ${err.message}`);
	});
	proc.on("exit", (code) => {
		if (!current()) return;
		mic = null;
		runningKey = "";
		vad.reset();
		const reason = errors.trim().split("\n")[0] ?? "";
		if (code === 2 || restarts >= 5) {
			fail(explainWakeError(reason));
			return;
		}
		// Se cerró sin avisar: se vuelve a abrir en un rato.
		restarts++;
		restartTimer = setTimeout(() => {
			restartTimer = null;
			syncWakeListener();
		}, 5000);
		restartTimer.unref();
	});
	proc.unref();
	status = { state: "listening" };
}

/** Qué hacer al oír la palabra (lo pone app.ts, el único que tiene la bandeja). Sin esto, no se escucha. */
export function setWakeHandler(fn: (() => void) | null): void {
	handler = fn;
	syncWakeListener();
}

/** Arranca, para o reinicia la escucha según los ajustes. Se llama al arrancar y al guardar Ajustes → Voz. */
export function syncWakeListener(): void {
	const want = process.platform === "win32" && handler !== null && getConfig().wakeWordEnabled;
	if (!want) {
		stop();
		restarts = 0;
		status = { state: "off" };
		return;
	}
	if (runningKey === configKey() && (mic || status.state === "downloading" || status.state === "starting")) return;
	if (restartTimer && !mic) return;
	stop();
	status = { state: "starting" };
	void start();
}

/** Para Ajustes: si se puede usar aquí (Windows y Aku con su ícono en la bandeja) y cómo va. */
export function wakeStatus(): WakeState & { available: boolean; model: string } {
	const p = wakeDownloadProgress();
	const progress = status.state === "downloading" && p ? Math.min(1, p.received / p.total) : undefined;
	return { available: process.platform === "win32" && handler !== null, model: ASR_PACK.id, ...status, ...(progress !== undefined ? { progress } : {}) };
}
