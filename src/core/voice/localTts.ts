/**
 * La voz de Aku sin internet (Ajustes → Voz → «Aku (sin internet)»): sherpa-onnx con voces Piper o Kokoro
 * que corren en el procesador. Las voces se descargan solo cuando el usuario las elige, de las versiones
 * oficiales de sherpa-onnx en GitHub (`k2-fsa/sherpa-onnx`, etiqueta `tts-models`), con la huella sha256
 * fijada aquí, y quedan en `data/voices/<paquete>/`.
 *
 * Un solo modelo cargado a la vez (el de la última voz usada) y una frase a la vez: la web pide las frases
 * por adelantado y salen en orden.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR } from "../../config/config.js";
import { downloadAsset, tarCommand } from "../llamacpp/install.js";
import { loadSherpa, type OfflineTtsInstance } from "./sherpaLoader.js";

export const VOICES_DIR = join(DATA_DIR, "voices");
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

type PackKind = "piper" | "kokoro";
export type VoicePack = { id: string; kind: PackKind; size: number; sha256: string };
export type LocalVoice = { id: string; label: string; hint: string; pack: string; sid: number };

/** Paquetes que se pueden descargar (nombre del archivo sin `.tar.bz2` = carpeta que trae dentro). */
export const VOICE_PACKS: VoicePack[] = [
	{ id: "vits-piper-es_MX-claude-high-int8", kind: "piper", size: 21_216_685, sha256: "0f9fc9c07d2e17bdc0f5f33a657addae92085da85704cb86a861e59d32f3bbfa" },
	{ id: "vits-piper-es_MX-ald-medium-int8", kind: "piper", size: 21_283_187, sha256: "447e82d080719409db08e54a4b6eec2e4b6ba850b98dcaf09d3fc67bf30ff692" },
	{ id: "vits-piper-es_AR-daniela-high-int8", kind: "piper", size: 35_069_782, sha256: "7218f0a119e4c16533ac187f71ab3019f2092f1594e43fef8392ae1f5b64abab" },
	{ id: "vits-piper-es_ES-davefx-medium-int8", kind: "piper", size: 21_171_632, sha256: "8bb8ac1cefb727caec9bd9c6c3185c673c8b42c53bd29bb25d5a7715dac37125" },
	{ id: "kokoro-int8-multi-lang-v1_0", kind: "kokoro", size: 132_353_410, sha256: "72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653" },
];

/** Las voces que ve el usuario. Las de Kokoro comparten un paquete (cada una es un número de hablante). */
export const LOCAL_VOICES: LocalVoice[] = [
	{ id: "piper-claude", label: "Claude · México", hint: "Piper, rápida", pack: "vits-piper-es_MX-claude-high-int8", sid: 0 },
	{ id: "piper-ald", label: "Ald · México", hint: "Piper, rápida", pack: "vits-piper-es_MX-ald-medium-int8", sid: 0 },
	{ id: "piper-daniela", label: "Daniela · Argentina", hint: "Piper, rápida", pack: "vits-piper-es_AR-daniela-high-int8", sid: 0 },
	{ id: "piper-davefx", label: "Davefx · España", hint: "Piper, rápida", pack: "vits-piper-es_ES-davefx-medium-int8", sid: 0 },
	{ id: "kokoro-dora", label: "Dora (mujer)", hint: "Kokoro, más natural y más lenta", pack: "kokoro-int8-multi-lang-v1_0", sid: 28 },
	{ id: "kokoro-alex", label: "Alex (hombre)", hint: "Kokoro, más natural y más lenta", pack: "kokoro-int8-multi-lang-v1_0", sid: 29 },
	{ id: "kokoro-santa", label: "Santa (hombre)", hint: "Kokoro, más natural y más lenta", pack: "kokoro-int8-multi-lang-v1_0", sid: 53 },
];

export const findVoice = (id: string) => LOCAL_VOICES.find((v) => v.id === id);
const findPack = (id: string) => VOICE_PACKS.find((p) => p.id === id);
const packDir = (id: string) => join(VOICES_DIR, id);
const isInstalled = (id: string) => existsSync(join(packDir(id), ".completo"));

// ─────────────────────────── Descargas ───────────────────────────

export type PackState = { phase: "downloading" | "extracting" | "error"; received: number; total: number; error?: string };
const installs = new Map<string, PackState>();
const running = new Map<string, Promise<void>>();

function run(file: string, args: string[], timeoutMs: number): Promise<void> {
	return new Promise((res, rej) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
			if (err) return rej(new Error(String(stderr || err.message).trim().split("\n")[0]));
			res();
		});
	});
}

async function doInstall(pack: VoicePack): Promise<void> {
	const st: PackState = { phase: "downloading", received: 0, total: pack.size };
	installs.set(pack.id, st);
	mkdirSync(VOICES_DIR, { recursive: true });
	const archive = join(VOICES_DIR, `.descarga-${pack.id}.tar.bz2`);
	const tmp = join(VOICES_DIR, `.descomprimir-${pack.id}`);
	try {
		await downloadAsset(
			{ name: `${pack.id}.tar.bz2`, size: pack.size, browser_download_url: `${RELEASE}/${pack.id}.tar.bz2`, digest: `sha256:${pack.sha256}` },
			archive,
			(n) => (st.received += n),
		);
		st.phase = "extracting";
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		// tar reconoce solo el .bz2 (el de Windows y el de Linux).
		await run(tarCommand(), ["-xf", archive, "-C", tmp], 10 * 60_000).catch((err) => {
			throw new Error(`No pude descomprimir la voz: ${err instanceof Error ? err.message : String(err)}`);
		});
		const inner = join(tmp, pack.id);
		if (!existsSync(inner)) throw new Error("La voz descargada no trae lo esperado.");
		writeFileSync(join(inner, ".completo"), new Date().toISOString());
		rmSync(packDir(pack.id), { recursive: true, force: true });
		renameSync(inner, packDir(pack.id));
		installs.delete(pack.id);
	} catch (err) {
		installs.set(pack.id, { ...st, phase: "error", error: err instanceof Error ? err.message : String(err) });
		throw err;
	} finally {
		rmSync(archive, { force: true });
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Descarga la voz (su paquete). Si ya se está descargando, devuelve esa misma descarga. */
export function installVoice(voiceId: string): Promise<void> {
	const voice = findVoice(voiceId);
	const pack = voice && findPack(voice.pack);
	if (!pack) return Promise.reject(new Error("Esa voz no existe."));
	if (isInstalled(pack.id)) return Promise.resolve();
	let job = running.get(pack.id);
	if (!job) {
		job = doInstall(pack).finally(() => running.delete(pack.id));
		running.set(pack.id, job);
	}
	return job;
}

/** Borra la voz descargada (todo su paquete: con Kokoro, las tres voces). */
export function removeVoice(voiceId: string): void {
	const voice = findVoice(voiceId);
	if (!voice) throw new Error("Esa voz no existe.");
	if (running.has(voice.pack)) throw new Error("Esa voz se está descargando.");
	if (engine?.pack === voice.pack) engine = null;
	rmSync(packDir(voice.pack), { recursive: true, force: true });
	installs.delete(voice.pack);
}

export type VoiceStatus = LocalVoice & { size: number; installed: boolean; state?: PackState };

export function listLocalVoices(): VoiceStatus[] {
	return LOCAL_VOICES.map((v) => {
		const pack = findPack(v.pack)!;
		return { ...v, size: pack.size, installed: isInstalled(pack.id), state: installs.get(pack.id) };
	});
}

// ─────────────────────────── Hablar ───────────────────────────

let engine: { pack: string; tts: Promise<OfflineTtsInstance> } | null = null;
/** Una frase a la vez: el modelo no se usa desde dos sitios a la vez y las frases salen en orden. */
let queue: Promise<unknown> = Promise.resolve();

function firstOnnx(dir: string): string {
	const f = readdirSync(dir).find((n) => n.endsWith(".onnx") && statSync(join(dir, n)).isFile());
	if (!f) throw new Error("La voz descargada está incompleta: bórrala y descárgala otra vez.");
	return join(dir, f);
}

function engineConfig(pack: VoicePack): unknown {
	const dir = packDir(pack.id);
	const numThreads = Math.max(1, Math.min(4, cpus().length - 1));
	const model =
		pack.kind === "kokoro"
			? {
					kokoro: {
						model: firstOnnx(dir),
						voices: join(dir, "voices.bin"),
						tokens: join(dir, "tokens.txt"),
						dataDir: join(dir, "espeak-ng-data"),
						lexicon: `${join(dir, "lexicon-us-en.txt")},${join(dir, "lexicon-zh.txt")}`,
						lang: "es",
					},
				}
			: { vits: { model: firstOnnx(dir), tokens: join(dir, "tokens.txt"), dataDir: join(dir, "espeak-ng-data") } };
	return { model: { ...model, numThreads, provider: "cpu", debug: false }, maxNumSentences: 1 };
}

function getEngine(pack: VoicePack): Promise<OfflineTtsInstance> {
	if (engine?.pack !== pack.id) {
		const tts = loadSherpa().OfflineTts.createAsync(engineConfig(pack));
		engine = { pack: pack.id, tts };
		// Si falla al cargar, que el próximo intento vuelva a probar.
		tts.catch(() => engine?.tts === tts && (engine = null));
	}
	return engine.tts;
}

/** Audio de 16 bits en un archivo WAV (lo que reproduce cualquier navegador). */
export function toWav(samples: Float32Array, sampleRate: number): Buffer {
	const data = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		data.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
	}
	const head = Buffer.alloc(44);
	head.write("RIFF", 0);
	head.writeUInt32LE(36 + data.length, 4);
	head.write("WAVE", 8);
	head.write("fmt ", 12);
	head.writeUInt32LE(16, 16);
	head.writeUInt16LE(1, 20); // PCM
	head.writeUInt16LE(1, 22); // mono
	head.writeUInt32LE(sampleRate, 24);
	head.writeUInt32LE(sampleRate * 2, 28);
	head.writeUInt16LE(2, 32);
	head.writeUInt16LE(16, 34);
	head.write("data", 36);
	head.writeUInt32LE(data.length, 40);
	return Buffer.concat([head, data]);
}

/** Lee un texto con una voz descargada y devuelve el WAV. */
export function speakLocal(text: string, voiceId: string, speed = 1): Promise<Buffer> {
	const voice = findVoice(voiceId);
	const pack = voice && findPack(voice.pack);
	if (!voice || !pack) return Promise.reject(new Error("Elige una voz en Ajustes → Voz."));
	if (!isInstalled(pack.id)) return Promise.reject(new Error(`La voz «${voice.label}» no está descargada: descárgala en Ajustes → Voz.`));
	const job = queue.then(async () => {
		const tts = await getEngine(pack);
		const audio = await tts.generateAsync({ text, sid: Math.min(voice.sid, Math.max(0, tts.numSpeakers - 1)), speed: Math.max(0.5, Math.min(2, speed)) });
		if (!audio.samples.length) throw new Error("La voz no generó sonido para ese texto.");
		return toWav(audio.samples, audio.sampleRate);
	});
	queue = job.catch(() => {});
	return job;
}
