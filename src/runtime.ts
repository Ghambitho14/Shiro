/**
 * Dónde está Shiro: en la carpeta del proyecto (npm start) o dentro de Shiro.exe (npm run exe).
 * En el .exe, la web (public/) y sus librerías van dentro del archivo (assets de Node SEA) y
 * los datos quedan fuera: carpeta "data" junto al .exe si existe, si no %APPDATA%\Shiro.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";

/** true si Shiro corre desde Shiro.exe. */
export const IS_EXE = isSea();

/** Carpeta del proyecto, o la del .exe. */
export const APP_DIR = IS_EXE ? dirname(process.execPath) : join(dirname(fileURLToPath(import.meta.url)), "..");

/** Archivos de librerías que la web pide en /vendor/<nombre>. Lista cerrada: nada más de node_modules. */
export const VENDOR_FILES: Record<string, string> = {
	"marked.js": "node_modules/marked/lib/marked.umd.js",
	"purify.js": "node_modules/dompurify/dist/purify.min.js",
	"highlight.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
	"hljs-light.css": "node_modules/@highlightjs/cdn-assets/styles/github.min.css",
	"hljs-dark.css": "node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css",
};

/** El motor de SQLite (sql.js) para el índice de chats. */
export const SQL_WASM_FILE = "node_modules/sql.js/dist/sql-wasm.wasm";

/**
 * Lee un archivo de la app ("public/index.html", "package.json"…): de dentro del .exe o de la
 * carpeta del proyecto. null si no existe. Rutas siempre con "/".
 */
export function readAppFile(rel: string): Buffer | null {
	if (IS_EXE) {
		try {
			return Buffer.from(getAsset(rel));
		} catch {
			return null;
		}
	}
	const full = join(APP_DIR, rel);
	try {
		return statSync(full).isFile() ? readFileSync(full) : null;
	} catch {
		return null;
	}
}

export const APP_VERSION: string = (() => {
	try {
		return (JSON.parse(readAppFile("package.json")?.toString("utf-8") ?? "{}") as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

/** Carpeta de datos (separado de config.ts para poder probarlo). */
export function resolveDataDir(opts: {
	env?: NodeJS.ProcessEnv;
	isExe?: boolean;
	appDir?: string;
	exists?: (path: string) => boolean;
} = {}): string {
	const { env = process.env, isExe = IS_EXE, appDir = APP_DIR, exists = existsSync } = opts;
	if (env.SHIRO_DATA_DIR?.trim()) return resolve(env.SHIRO_DATA_DIR.trim());
	const local = join(appDir, "data");
	if (!isExe || exists(local)) return local;
	return env.APPDATA?.trim() ? join(env.APPDATA.trim(), "Shiro") : join(homedir(), ".shiro");
}

/** Cómo lanzan otras apps (OpenCode, Claude Code…) a Shiro como servidor MCP. */
export function shiroMcpCommand(): { command: string; args: string[] } {
	if (IS_EXE) return { command: process.execPath.replace(/\\/g, "/"), args: ["mcp"] };
	return { command: "node", args: [join(APP_DIR, "bin", "shiro-mcp.mjs").replace(/\\/g, "/")] };
}
