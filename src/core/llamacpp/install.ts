/**
 * Descarga llama.cpp (el programa llama-server) de las versiones oficiales de GitHub
 * (ggml-org/llama.cpp) y lo deja en data/llama.cpp/<versión>-<tipo>/.
 * Con NVIDIA se baja la versión CUDA (más rápida) junto con sus librerías (cudart);
 * si no, Vulkan en Windows (cualquier tarjeta) o CPU.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { DATA_DIR, getConfig, type AppConfig } from "../../config/config.js";

export const ENGINE_DIR = join(DATA_DIR, "llama.cpp");
const INSTALL_FILE = join(ENGINE_DIR, "install.json");
const RELEASES_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10";

export type Backend = "cuda" | "vulkan" | "cpu" | "metal";
export type BackendChoice = AppConfig["llamaBackend"];
export type ReleaseAsset = { name: string; size: number; browser_download_url: string; digest?: string | null };
export type Release = { tag_name: string; assets: ReleaseAsset[] };
/** Qué descargar: el paquete de llama.cpp y, con CUDA en Windows, las librerías de CUDA. */
export type Download = { tag: string; variant: string; main: ReleaseAsset; extra?: ReleaseAsset };
export type Target = { platform: NodeJS.Platform; arch: string; backend: Backend; cudaMajor?: number };
export type Installed = { tag: string; backend: Backend; variant: string; exe: string; installedAt: string };
export type NvidiaInfo = { name: string; driver: string; cudaMajor?: number };

export const BACKEND_LABELS: Record<Backend, string> = { cuda: "CUDA (NVIDIA)", vulkan: "Vulkan", cpu: "Solo procesador", metal: "Metal (Mac)" };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Elige los archivos de una versión para este equipo. Con CUDA, la versión más alta que
 * admite el driver; en Windows además hacen falta sus librerías (cudart-…).
 */
export function pickAssets(release: Release, t: Target): Download | null {
	const tag = release.tag_name;
	const arch = t.arch === "x64" || t.arch === "arm64" ? t.arch : null;
	if (!arch) return null;
	const find = (name: string) => release.assets.find((a) => a.name === name);
	const prefix = `llama-${tag}-bin-`;
	if (t.platform === "darwin") {
		const main = find(`${prefix}macos-${arch}.tar.gz`);
		return main ? { tag, variant: "metal", main } : null;
	}
	const os = t.platform === "win32" ? "win" : t.platform === "linux" ? "ubuntu" : null;
	if (!os) return null;
	const ext = os === "win" ? "zip" : "tar.gz";
	if (t.backend === "cuda") {
		const re = new RegExp(`^${escapeRe(prefix)}${os}-cuda-(\\d+)\\.(\\d+)-${arch}\\.${escapeRe(ext)}$`);
		const options = release.assets
			.map((a) => ({ a, m: re.exec(a.name) }))
			.filter((x): x is { a: ReleaseAsset; m: RegExpExecArray } => x.m !== null && Number(x.m[1]) <= (t.cudaMajor ?? 0))
			.sort((x, y) => Number(y.m[1]) - Number(x.m[1]) || Number(y.m[2]) - Number(x.m[2]));
		for (const { a, m } of options) {
			const ver = `${m[1]}.${m[2]}`;
			const extra = os === "win" ? find(`cudart-llama-bin-win-cuda-${ver}-${arch}.zip`) : find(`cudart-llama-${tag}-bin-ubuntu-cuda-${ver}-${arch}.tar.gz`);
			if (os === "win" && !extra) continue;
			return { tag, variant: `cuda-${ver}`, main: a, ...(extra ? { extra } : {}) };
		}
		return null;
	}
	const name =
		t.backend === "vulkan" ? `${prefix}${os}-vulkan-${arch}.${ext}` : os === "win" ? `${prefix}win-cpu-${arch}.zip` : `${prefix}ubuntu-${arch}.tar.gz`;
	const main = find(name);
	return main ? { tag, variant: t.backend, main } : null;
}

/** Versión de CUDA más alta que admite un driver de NVIDIA ("616.92" → 13). */
export function cudaMajorForDriver(driver: string): number | undefined {
	const major = Number.parseInt(driver, 10);
	if (major >= 580) return 13;
	if (major >= 551) return 12;
	return undefined;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((res, rej) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) return rej(new Error(String(stderr || err.message).trim().split("\n")[0]));
			res(String(stdout).trim());
		});
	});
}

let nvidiaCache: Promise<NvidiaInfo | null> | null = null;

/** Tarjeta NVIDIA y su driver (null si no hay o no está nvidia-smi). */
export function detectNvidia(): Promise<NvidiaInfo | null> {
	nvidiaCache ??= run("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"], 8000)
		.then((out) => {
			const [name, driver] = out.split(/\r?\n/)[0].split(",").map((s) => s.trim());
			return name && driver ? { name, driver, cudaMajor: cudaMajorForDriver(driver) } : null;
		})
		.catch(() => null);
	return nvidiaCache;
}

/** Tipo de llama.cpp que conviene a este equipo (o el elegido en Ajustes). */
export async function resolveTarget(choice: BackendChoice = getConfig().llamaBackend): Promise<Target> {
	const base = { platform: process.platform, arch: process.arch };
	if (process.platform === "darwin") return { ...base, backend: "metal" };
	const nvidia = await detectNvidia();
	if (choice === "cuda") {
		if (!nvidia) throw new Error("No encontré una tarjeta NVIDIA (nvidia-smi no responde). Elige Vulkan o Automático.");
		if (!nvidia.cudaMajor) throw new Error(`El driver de tu NVIDIA (${nvidia.driver}) es demasiado viejo para CUDA 12. Actualízalo o elige Vulkan.`);
		return { ...base, backend: "cuda", cudaMajor: nvidia.cudaMajor };
	}
	if (choice === "vulkan" || choice === "cpu") return { ...base, backend: choice };
	if (nvidia?.cudaMajor) return { ...base, backend: "cuda", cudaMajor: nvidia.cudaMajor };
	return { ...base, backend: process.platform === "win32" ? "vulkan" : "cpu" };
}

let releasesCache: { at: number; releases: Release[] } | null = null;

async function fetchReleases(): Promise<Release[]> {
	if (releasesCache && Date.now() - releasesCache.at < 30 * 60_000) return releasesCache.releases;
	let res: Response;
	try {
		res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Shiro" }, signal: AbortSignal.timeout(20_000) });
	} catch {
		throw new Error("No pude conectar con GitHub para ver las versiones de llama.cpp. Revisa la conexión a internet.");
	}
	if (res.status === 403 || res.status === 429) throw new Error("GitHub limita las consultas seguidas: espera unos minutos y vuelve a intentarlo.");
	if (!res.ok) throw new Error(`GitHub respondió ${res.status} al pedir las versiones de llama.cpp.`);
	const data = (await res.json()) as Release[];
	const releases = Array.isArray(data) ? data.filter((r) => typeof r?.tag_name === "string" && Array.isArray(r.assets)) : [];
	releasesCache = { at: Date.now(), releases };
	return releases;
}

/** La versión más nueva que trae archivos para este equipo. */
export async function findDownload(target: Target): Promise<Download> {
	for (const release of await fetchReleases()) {
		const pick = pickAssets(release, target);
		if (pick) return pick;
	}
	throw new Error(`No encontré una versión de llama.cpp (${BACKEND_LABELS[target.backend]}) para este equipo.`);
}

/** La versión instalada, con la ruta completa de llama-server. null si no hay o le faltan archivos. */
export function getInstalled(): (Installed & { exePath: string }) | null {
	try {
		const info = JSON.parse(readFileSync(INSTALL_FILE, "utf-8")) as Installed;
		const exePath = resolve(ENGINE_DIR, info.exe);
		if (!exePath.startsWith(resolve(ENGINE_DIR) + sep) || !existsSync(exePath)) return null;
		return { ...info, exePath };
	} catch {
		return null;
	}
}

export type InstallState = {
	phase: "idle" | "downloading" | "extracting" | "done" | "error";
	received: number;
	total: number;
	tag?: string;
	variant?: string;
	error?: string;
};

let state: InstallState = { phase: "idle", received: 0, total: 0 };
let running: Promise<Installed> | null = null;

export function getInstallState(): InstallState {
	return { ...state };
}

/** Descarga un archivo de GitHub comprobando su huella sha256. Se cancela si pasa 1 minuto sin recibir datos. */
async function downloadAsset(asset: ReleaseAsset, file: string, onBytes: (n: number) => void): Promise<void> {
	if (!asset.browser_download_url.startsWith("https://github.com/")) throw new Error(`Dirección de descarga inesperada para ${asset.name}.`);
	const ctrl = new AbortController();
	let timer = setTimeout(() => ctrl.abort(), 60_000);
	const bump = () => {
		clearTimeout(timer);
		timer = setTimeout(() => ctrl.abort(), 60_000);
	};
	try {
		const res = await fetch(asset.browser_download_url, { headers: { "User-Agent": "Shiro" }, signal: ctrl.signal });
		if (!res.ok || !res.body) throw new Error(`GitHub respondió ${res.status} al descargar ${asset.name}.`);
		const hash = createHash("sha256");
		const meter = new Transform({
			transform(chunk: Buffer, _enc, cb) {
				hash.update(chunk);
				onBytes(chunk.length);
				bump();
				cb(null, chunk);
			},
		});
		await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), meter, createWriteStream(file));
		const want = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7).toLowerCase() : "";
		if (want && hash.digest("hex") !== want) throw new Error(`La descarga de ${asset.name} llegó dañada. Vuelve a intentarlo.`);
	} catch (err) {
		if (ctrl.signal.aborted) throw new Error("La descarga se quedó parada más de un minuto. Revisa la conexión y vuelve a intentarlo.");
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** En Windows se usa el tar del sistema (abre .zip); el de Git que puede haber en el PATH no. */
function tarCommand(): string {
	return process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

async function extract(archive: string, dir: string): Promise<void> {
	try {
		await run(tarCommand(), [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", dir], 10 * 60_000);
	} catch (err) {
		throw new Error(`No pude descomprimir ${archive.split(/[\\/]/).pop()}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function findServerExe(dir: string, depth = 0): string | null {
	const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === name);
	if (hit) return join(dir, hit.name);
	if (depth >= 4) return null;
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const found = findServerExe(join(dir, e.name), depth + 1);
		if (found) return found;
	}
	return null;
}

/**
 * Descarga e instala llama.cpp. Si ya hay una descarga en marcha, devuelve esa.
 * `beforeSwap` se llama antes de reemplazar la versión anterior (para cerrar el servidor que la usa).
 */
export function installLlamaCpp(opts: { backend?: BackendChoice; beforeSwap?: () => Promise<void> | void } = {}): Promise<Installed> {
	running ??= doInstall(opts).finally(() => {
		running = null;
	});
	return running;
}

async function doInstall(opts: { backend?: BackendChoice; beforeSwap?: () => Promise<void> | void }): Promise<Installed> {
	state = { phase: "downloading", received: 0, total: 0 };
	let tmp = "";
	try {
		const target = await resolveTarget(opts.backend);
		const pick = await findDownload(target);
		const assets = [pick.main, ...(pick.extra ? [pick.extra] : [])];
		state = { ...state, tag: pick.tag, variant: pick.variant, total: assets.reduce((n, a) => n + a.size, 0) };
		mkdirSync(ENGINE_DIR, { recursive: true });
		tmp = join(ENGINE_DIR, `.tmp-${randomBytes(4).toString("hex")}`);
		const binDir = join(tmp, "bin");
		mkdirSync(binDir, { recursive: true });

		const files: string[] = [];
		for (const asset of assets) {
			if (!/^[\w.-]+$/.test(asset.name)) throw new Error(`Nombre de archivo inesperado: ${asset.name}`);
			const file = join(tmp, asset.name);
			await downloadAsset(asset, file, (n) => (state.received += n));
			files.push(file);
		}

		state = { ...state, phase: "extracting" };
		await extract(files[0], binDir);
		const exe = findServerExe(binDir);
		if (!exe) throw new Error("El paquete descargado no trae llama-server.");
		if (files[1]) await extract(files[1], dirname(exe));
		if (process.platform !== "win32") chmodSync(exe, 0o755);

		const finalDir = join(ENGINE_DIR, `${pick.tag}-${pick.variant}`);
		await opts.beforeSwap?.();
		rmSync(finalDir, { recursive: true, force: true });
		renameSync(binDir, finalDir);
		const installed: Installed = {
			tag: pick.tag,
			backend: target.backend,
			variant: pick.variant,
			exe: relative(ENGINE_DIR, join(finalDir, relative(binDir, exe))),
			installedAt: new Date().toISOString(),
		};
		writeFileSync(INSTALL_FILE, JSON.stringify(installed, null, 2), "utf-8");

		// Las versiones anteriores sobran (si alguna está en uso, se borrará la próxima vez).
		for (const e of readdirSync(ENGINE_DIR, { withFileTypes: true })) {
			const dir = join(ENGINE_DIR, e.name);
			if (!e.isDirectory() || dir === finalDir || dir === tmp) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// en uso
			}
		}
		state = { ...state, phase: "done" };
		return installed;
	} catch (err) {
		state = { ...state, phase: "error", error: err instanceof Error ? err.message : String(err) };
		throw err;
	} finally {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	}
}
