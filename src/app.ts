/**
 * `npm run app`: arranca el servidor (si no estaba ya) y abre Shiro en su propia ventana,
 * sin barra del navegador, como una aplicación de escritorio.
 * `npm run app -- --acceso-directo` (o `Shiro.exe --acceso-directo`) crea además un icono "Shiro" en el escritorio.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { IS_WINDOWS, runPowerShell } from "./core/pc/powershell.js";
import { findInstalledBrowser } from "./core/browser/findBrowser.js";
import { APP_DIR, IS_EXE, readAppFile } from "./runtime.js";

/** Cómo se vuelve a abrir Shiro (para los mensajes). */
const OPEN_AGAIN = IS_EXE ? "abre Shiro.exe" : "npm start";
/** Puerto de este Shiro. Con el .exe puede cambiar si el 1406 lo usa otro Shiro (ver pickExePort). */
let PORT = Number(process.env.PORT) || 1406;

type Health = { startedAt?: number; pid?: number };

/** Lo que responde un Shiro ya abierto en este puerto, o null si no hay ninguno. */
async function runningServer(url: string): Promise<Health | null> {
	try {
		const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
		return r.ok ? ((await r.json().catch(() => ({}))) as Health) : null;
	} catch {
		return null;
	}
}

/** Fecha del archivo de código más reciente (o del .exe): si es posterior al arranque del servidor, este está anticuado. */
function newestCodeChange(): number {
	if (IS_EXE) {
		try {
			return statSync(process.execPath).mtimeMs;
		} catch {
			return 0;
		}
	}
	let newest = 0;
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.(ts|mjs|js|json)$/.test(e.name) && !e.name.includes(".test.")) newest = Math.max(newest, statSync(full).mtimeMs);
		}
	};
	try {
		walk(join(APP_DIR, "src"));
		newest = Math.max(newest, statSync(join(APP_DIR, "package.json")).mtimeMs);
	} catch {
		// si no se puede leer, se da por actualizado
	}
	return newest;
}

/** La clave que dejó el servidor de ESTA instalación (misma carpeta de datos) en ese puerto. */
function ownServerInfo(port: number): { pid?: number; token?: string } | null {
	try {
		return JSON.parse(readFileSync(join(DATA_DIR, "cache", `server-${port}.json`), "utf-8")) as { pid?: number; token?: string };
	} catch {
		return null;
	}
}

/**
 * Con el .exe, otro Shiro (p. ej. el de npm run dev, con otros datos) puede estar en el 1406: abrir ese
 * mostraría sus chats. Se usa el puerto de un Shiro propio si ya hay uno abierto; si no, el primero libre.
 */
async function pickExePort(first: number): Promise<number> {
	let free: number | null = null;
	for (let port = first; port < first + 20; port++) {
		const health = await runningServer(`http://127.0.0.1:${port}`);
		if (!health) free ??= port;
		else if (health.pid && ownServerInfo(port)?.pid === health.pid) return port;
	}
	return free ?? first;
}

/**
 * Cierra un Shiro anticuado que siga abierto (p. ej. tras actualizar el código) para arrancar el nuevo.
 * Solo funciona con servidores que dejaron su clave en data/cache/server-<puerto>.json.
 */
async function stopOutdatedServer(url: string, health: Health): Promise<boolean> {
	try {
		const info = ownServerInfo(PORT);
		if (!info?.token || info.pid !== health.pid) return false;
		const r = await fetch(`${url}/api/local/shutdown`, { method: "POST", headers: { "x-shiro-local": info.token }, signal: AbortSignal.timeout(3000) });
		if (!r.ok) return false;
	} catch {
		return false;
	}
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 250));
		if (!(await runningServer(url))) return true;
	}
	return false;
}

function detached(file: string, args: string[]): void {
	const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
	child.on("error", () => console.log(`  Abre en tu navegador: ${args[args.length - 1]}`));
	child.unref();
}

export function openAppWindow(url: string): void {
	const browser = findInstalledBrowser();
	if (browser) {
		detached(browser, [`--app=${url}`, "--window-size=1180,820"]);
		return;
	}
	if (process.platform === "win32") detached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
	else detached(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/** Acceso directo en el escritorio que abre Shiro.exe, o ejecuta `npm run app` en esta carpeta. */
async function createDesktopShortcut(): Promise<void> {
	if (!IS_WINDOWS) {
		console.log("  El acceso directo solo se crea automáticamente en Windows.");
		return;
	}
	const cacheDir = join(DATA_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	// La imagen del icono: dentro del .exe no es un archivo, así que se copia a la caché.
	const png = join(cacheDir, "shiro-icon.png");
	const pngData = readAppFile("public/Shiro.PNG");
	if (!pngData) throw new Error("no encuentro la imagen del icono");
	writeFileSync(png, pngData);
	const out = await runPowerShell(
		String.raw`
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($env:SHIRO_A_PNG)
$bmp = New-Object System.Drawing.Bitmap $src, 256, 256
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png)
[System.IO.File]::WriteAllBytes($env:SHIRO_A_ICO, $ico.ToArray())
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'Shiro.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
$lnk.TargetPath = $env:SHIRO_A_TARGET
$lnk.Arguments = [string]$env:SHIRO_A_ARGS
$lnk.WorkingDirectory = $env:SHIRO_A_DIR
$lnk.WindowStyle = 7
$lnk.IconLocation = $env:SHIRO_A_ICO
$lnk.Description = 'Shiro, tu asistente'
$lnk.Save()
$path`,
		{
			png,
			ico: join(cacheDir, "shiro.ico"),
			dir: APP_DIR,
			target: IS_EXE ? process.execPath : process.env.ComSpec || "cmd.exe",
			args: IS_EXE ? "" : "/c npm run app",
		},
	);
	console.log(`  ✓ Acceso directo creado: ${out}`);
}

export async function runApp(argv: string[] = []): Promise<void> {
	if (argv.includes("--acceso-directo") || argv.includes("--shortcut")) {
		try {
			await createDesktopShortcut();
		} catch (err) {
			console.log(`  No pude crear el acceso directo: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (IS_EXE && !process.env.PORT) {
		PORT = await pickExePort(PORT);
		process.env.PORT = String(PORT); // server.ts lo lee al cargarse
	}
	const localUrl = `http://127.0.0.1:${PORT}`;
	const running = await runningServer(localUrl);
	if (running) {
		const outdated = !running.startedAt || newestCodeChange() > running.startedAt;
		if (!outdated) {
			console.log("  Shiro ya estaba en marcha: abro la ventana.");
			openAppWindow(localUrl);
			return;
		}
		if (!(await stopOutdatedServer(localUrl, running))) {
			// Con el .exe suele ser otro Shiro (p. ej. el de npm run dev) usando el mismo puerto.
			const which = IS_EXE ? `otro Shiro en el puerto ${PORT} (por ejemplo, el de npm run dev)` : "un Shiro de antes de la última actualización";
			console.log(
				`\n  Hay ${which} y no puedo cerrarlo yo. Abro ese.` +
					`\n  Para usar este, ciérralo (Ctrl+C en su consola, o cierra esa ventana) y vuelve a ejecutar: ${OPEN_AGAIN}\n`,
			);
			openAppWindow(localUrl);
			return;
		}
		console.log("  Había un Shiro de antes de la última actualización: lo cerré y abro el nuevo.");
	}
	const { serverReady } = await import("./server.js");
	const url = await serverReady;
	openAppWindow(url);
	console.log("\n  Shiro está abierto en su ventana. Deja esta consola abierta mientras lo uses (ciérrala para apagarlo).\n");
}
