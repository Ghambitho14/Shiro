/**
 * Carga sherpa-onnx (la voz de Aku sin internet). Como la consola de la terminal (`ptyLoader.ts`),
 * trae binarios nativos que no se pueden abrir desde dentro de Aku.exe: ahí se copian la primera vez
 * a `data/cache/sherpa-onnx-<versión>/node_modules/` y se cargan de esa carpeta.
 * `npm run exe` los mete como assets (`sherpaPackageDirs()` en `collectAssets()` de buildExe.ts).
 *
 * Va fijada en la 1.13.x: la 2.0 quitó espeak-ng, que es lo que convierte el texto en sonidos
 * para las voces Piper y Kokoro en español.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAssetKeys } from "node:sea";
import { DATA_DIR } from "../../config/config.js";
import { APP_DIR, IS_EXE, readAppFile } from "../../runtime.js";

export type GeneratedAudio = { samples: Float32Array; sampleRate: number };
export type OfflineTtsInstance = {
	sampleRate: number;
	numSpeakers: number;
	generateAsync(req: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>;
};
export type SherpaModule = {
	OfflineTts: { createAsync(config: unknown): Promise<OfflineTtsInstance> };
};

/** La parte con los binarios de este sistema (`win` y no `win32` en el nombre). */
export function sherpaPlatformPackage(platform: string = process.platform, arch: string = process.arch): string {
	return `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`;
}

export function sherpaPackageDirs(): string[] {
	return ["node_modules/sherpa-onnx-node", `node_modules/${sherpaPlatformPackage()}`];
}

/** Copia las dos partes fuera del .exe (una sola vez) y devuelve la carpeta que hace de raíz. */
function extractFromExe(): string {
	const manifest = readAppFile("node_modules/sherpa-onnx-node/package.json");
	if (!manifest) throw new Error("Este Aku.exe no trae la voz sin internet.");
	if (!readAppFile(`${sherpaPackageDirs()[1]}/package.json`)) throw new Error(`Este Aku.exe no trae la voz sin internet para ${process.platform}-${process.arch}.`);
	const { version } = JSON.parse(manifest.toString("utf-8")) as { version?: string };
	const root = join(DATA_DIR, "cache", `sherpa-onnx-${version ?? "0"}`);
	const done = join(root, ".completo");
	if (existsSync(done)) return root;
	const prefixes = sherpaPackageDirs().map((d) => `${d}/`);
	for (const key of getAssetKeys()) {
		if (!prefixes.some((p) => key.startsWith(p))) continue;
		const data = readAppFile(key);
		if (!data) continue;
		const target = join(root, key);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}
	writeFileSync(join(root, "package.json"), "{}");
	writeFileSync(done, "");
	return root;
}

let loaded: SherpaModule | null = null;

export function loadSherpa(): SherpaModule {
	if (loaded) return loaded;
	try {
		const root = IS_EXE ? extractFromExe() : APP_DIR;
		loaded = createRequire(join(root, "package.json"))("sherpa-onnx-node") as SherpaModule;
		return loaded;
	} catch (err) {
		throw new Error(`No pude cargar la voz sin internet: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}. Prueba a ejecutar npm install.`);
	}
}
