/**
 * Carga node-pty (la consola real de la terminal). Sus binarios nativos no se pueden abrir desde dentro
 * de Shiro.exe: ahí se copian la primera vez a `data/cache/node-pty-<versión>/` y se cargan de esa carpeta.
 * `npm run exe` los mete como assets (`ptyPackageDir()` en `collectAssets()` de buildExe.ts).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAssetKeys } from "node:sea";
import { DATA_DIR } from "../../config/config.js";
import { APP_DIR, IS_EXE, readAppFile } from "../../runtime.js";

export type PtyModule = typeof import("@lydell/node-pty");

/** La parte de la librería con los binarios de este sistema (la otra solo elige cuál cargar). */
export function ptyPackageName(platform: string = process.platform, arch: string = process.arch): string {
	return `@lydell/node-pty-${platform}-${arch}`;
}

export function ptyPackageDir(): string {
	return `node_modules/${ptyPackageName()}`;
}

/** Copia los archivos de la librería fuera del .exe (una sola vez) y devuelve la carpeta. */
function extractFromExe(): string {
	const prefix = `${ptyPackageDir()}/`;
	const manifest = readAppFile(`${prefix}package.json`);
	if (!manifest) throw new Error(`Este Aku.exe no trae la consola para ${process.platform}-${process.arch}.`);
	const { version } = JSON.parse(manifest.toString("utf-8")) as { version?: string };
	const dir = join(DATA_DIR, "cache", `node-pty-${version ?? "0"}`);
	const done = join(dir, ".completo");
	if (existsSync(done)) return dir;
	for (const key of getAssetKeys()) {
		if (!key.startsWith(prefix)) continue;
		const data = readAppFile(key);
		if (!data) continue;
		const target = join(dir, key);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
	}
	writeFileSync(done, "");
	return dir;
}

let loaded: PtyModule | null = null;

export function loadPty(): PtyModule {
	if (loaded) return loaded;
	try {
		const root = IS_EXE ? extractFromExe() : APP_DIR;
		loaded = createRequire(join(root, "package.json"))(ptyPackageName()) as PtyModule;
		return loaded;
	} catch (err) {
		throw new Error(`No pude cargar la consola de la terminal: ${err instanceof Error ? err.message : String(err)}. Prueba a ejecutar npm install.`);
	}
}
