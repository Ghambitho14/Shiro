/**
 * Los dos modelos del modo asistente, sin internet una vez bajados: el detector de voz Silero (cuándo
 * empieza y acaba una frase) y Moonshine en español (pasa la frase a texto para ver si empieza por «Aku»).
 * Se bajan una sola vez al encender el modo, solo de las versiones oficiales de sherpa-onnx en GitHub
 * (`k2-fsa/sherpa-onnx`, etiqueta `asr-models`) y con la huella sha256 fijada aquí, a `data/voices/`.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadAsset, tarCommand } from "../llamacpp/install.js";
import { VOICES_DIR } from "../voice/localTts.js";

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

export const ASR_PACK = {
	id: "sherpa-onnx-moonshine-base-es-quantized-2026-02-27",
	size: 50_846_902,
	sha256: "850c3dcc5dfccc8b1feb10bb221b11d6039b6f5c626241729f46863771016383",
};
export const VAD_FILE = {
	name: "silero_vad.onnx",
	size: 643_854,
	sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
};

export const asrDir = () => join(VOICES_DIR, ASR_PACK.id);
export const vadPath = () => join(VOICES_DIR, VAD_FILE.name);
export const wakeModelsReady = () => existsSync(join(asrDir(), ".completo")) && existsSync(vadPath());
/** Lo que baja la primera vez, para avisarlo en Ajustes. */
export const WAKE_DOWNLOAD_MB = Math.round((ASR_PACK.size + VAD_FILE.size) / 1_000_000);

export type WakeDownload = { received: number; total: number };
let job: Promise<void> | null = null;
let progress: WakeDownload | null = null;

/** Cuánto lleva la descarga (null si no se está bajando nada). */
export const wakeDownloadProgress = () => progress;

function untar(archive: string, dest: string): Promise<void> {
	return new Promise((res, rej) => {
		execFile(tarCommand(), ["-xf", archive, "-C", dest], { timeout: 10 * 60_000, windowsHide: true }, (err, _o, stderr) => {
			if (err) return rej(new Error(`No pude descomprimir el modelo de voz: ${String(stderr || err.message).trim().split("\n")[0]}`));
			res();
		});
	});
}

async function download(): Promise<void> {
	mkdirSync(VOICES_DIR, { recursive: true });
	progress = { received: 0, total: ASR_PACK.size + VAD_FILE.size };
	const count = (n: number) => progress && (progress.received += n);
	if (!existsSync(vadPath())) {
		const tmp = join(VOICES_DIR, `.descarga-${VAD_FILE.name}`);
		try {
			await downloadAsset({ name: VAD_FILE.name, size: VAD_FILE.size, browser_download_url: `${RELEASE}/${VAD_FILE.name}`, digest: `sha256:${VAD_FILE.sha256}` }, tmp, count);
			renameSync(tmp, vadPath());
		} finally {
			rmSync(tmp, { force: true });
		}
	} else count(VAD_FILE.size);
	if (existsSync(join(asrDir(), ".completo"))) return;
	const archive = join(VOICES_DIR, `.descarga-${ASR_PACK.id}.tar.bz2`);
	const tmp = join(VOICES_DIR, `.descomprimir-${ASR_PACK.id}`);
	try {
		const name = `${ASR_PACK.id}.tar.bz2`;
		await downloadAsset({ name, size: ASR_PACK.size, browser_download_url: `${RELEASE}/${name}`, digest: `sha256:${ASR_PACK.sha256}` }, archive, count);
		rmSync(tmp, { recursive: true, force: true });
		mkdirSync(tmp, { recursive: true });
		await untar(archive, tmp);
		const inner = join(tmp, ASR_PACK.id);
		if (!existsSync(join(inner, "tokens.txt"))) throw new Error("El modelo de voz descargado no trae lo esperado.");
		writeFileSync(join(inner, ".completo"), new Date().toISOString());
		rmSync(asrDir(), { recursive: true, force: true });
		renameSync(inner, asrDir());
	} finally {
		rmSync(archive, { force: true });
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Baja lo que falte (una sola descarga a la vez). */
export function ensureWakeModels(): Promise<void> {
	if (wakeModelsReady()) return Promise.resolve();
	job ??= download().finally(() => {
		job = null;
		progress = null;
	});
	return job;
}
