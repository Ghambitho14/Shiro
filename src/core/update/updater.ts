/**
 * Actualizaciones de Aku.exe. Mira la última versión publicada en GitHub (solo el repo fijo `UPDATE_REPO`),
 * y si es más nueva que `APP_VERSION` avisa (web, menú de la bandeja). Al pulsar «Actualizar» en Ajustes →
 * General: baja `AkuSetup-<versión>.exe` (solo de github.com), comprueba su huella sha256 con la que publica
 * GitHub, y un PowerShell aparte espera a que Aku se cierre, instala en silencio y vuelve a abrir Aku.
 * Los datos del usuario no se tocan (el instalador no los usa).
 *
 * Solo con Aku.exe en Windows: desde el código (npm run app, Kali) se avisa pero se actualiza con git.
 * Se publica una versión con `npm run publicar` (src/publish.ts).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { APP_VERSION, IS_EXE } from "../../runtime.js";
import { downloadAsset, type ReleaseAsset } from "../llamacpp/install.js";

export const UPDATE_REPO = "Ghambitho14/Shiro";
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = () => join(DATA_DIR, "cache", "update.json");
const DOWNLOAD_DIR = () => join(DATA_DIR, "cache", "update");

export type FoundUpdate = { version: string; asset: ReleaseAsset; notes: string; url: string };
type Saved = { checkedAt: number; latest?: FoundUpdate | null };

export type UpdateState = {
	current: string;
	/** Se puede instalar desde Aku (solo Aku.exe en Windows). */
	canInstall: boolean;
	phase: "idle" | "checking" | "downloading" | "installing" | "error";
	checkedAt?: string;
	latest?: { version: string; notes: string; url: string; size: number };
	available: boolean;
	received: number;
	total: number;
	error?: string;
};

/** -1, 0 o 1 al comparar "1.2.10" con "1.2.9" (números, no letras). Lo que no es un número cuenta como 0. */
export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

type GhRelease = { tag_name?: string; draft?: boolean; prerelease?: boolean; body?: string | null; html_url?: string; assets?: ReleaseAsset[] };

/** De una versión de GitHub, el instalador (con su huella) y el número de versión; null si no sirve. */
export function pickInstaller(release: GhRelease): FoundUpdate | null {
	if (!release.tag_name || release.draft || release.prerelease) return null;
	const version = release.tag_name.replace(/^v/i, "");
	if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
	const asset = (release.assets ?? []).find((a) => a.name === `AkuSetup-${version}.exe`);
	// Sin huella no se instala: no habría cómo saber si llegó entero y es el publicado.
	if (!asset || !asset.digest?.startsWith("sha256:") || !asset.browser_download_url.startsWith(`https://github.com/${UPDATE_REPO}/releases/download/`)) return null;
	return { version, asset, notes: (release.body ?? "").slice(0, 2000), url: release.html_url ?? `https://github.com/${UPDATE_REPO}/releases` };
}

function load(): Saved {
	try {
		return JSON.parse(readFileSync(STATE_FILE(), "utf-8")) as Saved;
	} catch {
		return { checkedAt: 0 };
	}
}

function save(s: Saved): void {
	try {
		mkdirSync(join(DATA_DIR, "cache"), { recursive: true });
		writeFileSync(STATE_FILE(), JSON.stringify(s), "utf-8");
	} catch {
		/* sin guardar: se vuelve a mirar la próxima vez */
	}
}

let saved = load();
let phase: UpdateState["phase"] = "idle";
let error: string | undefined;
let received = 0;
let total = 0;
let checking: Promise<FoundUpdate | null> | null = null;

const isNewer = (u: FoundUpdate | null | undefined): u is FoundUpdate => Boolean(u && compareVersions(u.version, APP_VERSION) > 0);

export function getUpdateState(): UpdateState {
	const latest = saved.latest;
	return {
		current: APP_VERSION,
		canInstall: IS_EXE && process.platform === "win32",
		phase,
		checkedAt: saved.checkedAt ? new Date(saved.checkedAt).toISOString() : undefined,
		latest: latest ? { version: latest.version, notes: latest.notes, url: latest.url, size: latest.asset.size } : undefined,
		available: isNewer(latest),
		received,
		total,
		error,
	};
}

/** La versión nueva si la hay (null si Aku está al día). Lanza un error en español si GitHub no responde. */
export function checkForUpdate(): Promise<FoundUpdate | null> {
	checking ??= (async () => {
		if (phase === "idle" || phase === "error") phase = "checking";
		error = undefined;
		try {
			const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
				headers: { Accept: "application/vnd.github+json", "User-Agent": "Aku" },
				signal: AbortSignal.timeout(15_000),
			});
			// 404: todavía no hay ninguna versión publicada.
			if (!res.ok && res.status !== 404) throw new Error(`GitHub respondió ${res.status}.`);
			const found = res.ok ? pickInstaller((await res.json()) as GhRelease) : null;
			saved = { checkedAt: Date.now(), latest: found };
			save(saved);
			return isNewer(found) ? found : null;
		} catch (err) {
			error = `No pude ver si hay una versión nueva: ${err instanceof Error ? err.message : String(err)}`;
			throw new Error(error);
		} finally {
			if (phase === "checking") phase = error ? "error" : "idle";
			checking = null;
		}
	})();
	return checking;
}

/** Revisa como mucho una vez al día. Devuelve la versión nueva si la hay; nunca lanza. */
export async function checkDaily(): Promise<FoundUpdate | null> {
	if (Date.now() - saved.checkedAt < CHECK_EVERY_MS) return isNewer(saved.latest) ? saved.latest : null;
	return checkForUpdate().catch(() => null);
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Con Aku.exe: revisa al arrancar (a los 30 s) y luego cada 6 horas, como mucho una vez al día.
 * `onFound` se llama una vez por cada versión nueva encontrada.
 */
export function startUpdateChecks(onFound: (u: FoundUpdate) => void): void {
	if (!IS_EXE || timer) return;
	let told = "";
	const tick = async () => {
		const u = await checkDaily();
		if (u && u.version !== told) {
			told = u.version;
			onFound(u);
		}
	};
	setTimeout(() => void tick(), 30_000).unref();
	timer = setInterval(() => void tick(), 6 * 60 * 60 * 1000);
	timer.unref();
}

/**
 * PowerShell que espera a que Aku se cierre, instala sin preguntas (Inno Setup) y lo vuelve a abrir.
 * Los datos van por variables de entorno, nunca dentro del script.
 */
export const INSTALL_PS = String.raw`
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id ([int]$env:SHIRO_A_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch { }
Start-Sleep -Milliseconds 800
$p = Start-Process -FilePath $env:SHIRO_A_SETUP -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-' -PassThru -Wait
if (Test-Path -LiteralPath $env:SHIRO_A_APP) { Start-Process -FilePath $env:SHIRO_A_APP }
exit $p.ExitCode
`;

/** Dónde deja Aku.exe el instalador (por usuario; ver installer/aku.iss). */
export function installedExePath(): string {
	const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || "", "AppData", "Local");
	return join(base, "Programs", "Aku", "Aku.exe");
}

/** El entorno sin claves: el instalador y el Aku que se vuelve a abrir no las necesitan por aquí. */
function envWithoutKeys(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)) env[k] = v;
	return env;
}

let installing: Promise<void> | null = null;

/**
 * Baja la versión nueva, comprueba su huella y deja lista la instalación; luego llama a `quit` para que Aku
 * se cierre (el instalador espera a que termine). Si ya está en marcha, devuelve esa misma.
 */
export function installUpdate(quit: () => void): Promise<void> {
	installing ??= (async () => {
		try {
			if (!(IS_EXE && process.platform === "win32")) throw new Error("Solo Aku.exe se actualiza solo. Desde el código, actualiza con git pull.");
			const found = isNewer(saved.latest) ? saved.latest : await checkForUpdate();
			if (!found) throw new Error("Aku ya está al día.");
			phase = "downloading";
			error = undefined;
			received = 0;
			total = found.asset.size;
			const dir = DOWNLOAD_DIR();
			// Los instaladores viejos ya no sirven.
			if (existsSync(dir)) for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
			mkdirSync(dir, { recursive: true });
			const setup = join(dir, found.asset.name);
			await downloadAsset(found.asset, setup, (n) => (received += n));
			phase = "installing";
			const child = spawn(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(INSTALL_PS, "utf16le").toString("base64")],
				{
					detached: true,
					stdio: "ignore",
					windowsHide: true,
					env: { ...envWithoutKeys(), SHIRO_A_PID: String(process.pid), SHIRO_A_SETUP: setup, SHIRO_A_APP: installedExePath() },
				},
			);
			child.unref();
			// Que la web alcance a recibir la respuesta antes de cerrar.
			setTimeout(quit, 1500).unref();
		} catch (err) {
			phase = "error";
			error = err instanceof Error ? err.message : String(err);
			throw new Error(error);
		}
	})().finally(() => {
		if (phase !== "installing") installing = null;
	});
	return installing;
}
