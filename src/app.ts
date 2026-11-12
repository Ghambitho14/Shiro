/**
 * `npm run app`: arranca el servidor (si no estaba ya) y abre Shiro en su propia ventana,
 * sin barra del navegador, como una aplicación de escritorio.
 * `npm run app -- --acceso-directo` (o `Shiro.exe --acceso-directo`) crea además un icono "Shiro" en el escritorio.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { IS_WINDOWS, runPowerShell } from "./core/pc/powershell.js";
import { focusOwnWindow, pinWindowToCorner } from "./core/pc/pc.js";
import { findInstalledBrowser } from "./core/browser/findBrowser.js";
import { resolveLLMSettings } from "./core/llm/providers.js";
import { APP_DIR, IS_EXE, readAppFile } from "./runtime.js";
import { setTrayStatus, startTray } from "./tray.js";
import { getState } from "./store.js";

/** Tamaño de la cajita de voz de la bandeja (píxeles lógicos, con la barra de título de Edge). */
const VOICE_BOX = { width: 420, height: 190 };

/** Cómo se vuelve a abrir Shiro (para los mensajes). */
const OPEN_AGAIN = IS_EXE ? "abre Aku.exe" : "npm start";
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

export function openAppWindow(url: string, size = { width: 1180, height: 820 }, prefer?: "chrome"): void {
	const browser = findInstalledBrowser(prefer);
	if (browser) {
		detached(browser, [`--app=${url}`, `--window-size=${size.width},${size.height}`]);
		return;
	}
	if (process.platform === "win32") detached("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
	else detached(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

/** Clic en el ícono de la bandeja: trae al frente la ventana de Aku si ya está abierta; si no, abre una. */
async function showAppWindow(url: string): Promise<void> {
	const focused = await focusOwnWindow(getState().name || "Aku").catch(() => false);
	if (!focused) openAppWindow(url);
}

/** «Nuevo chat» del menú: la ventana al frente con un chat vacío (su atajo Ctrl+Mayús+O), o una ventana nueva. */
async function newChatWindow(url: string): Promise<void> {
	const focused = await focusOwnWindow(getState().name || "Aku", { newChat: true }).catch(() => false);
	if (!focused) openAppWindow(url);
}

/**
 * «Hablarle» del menú: la cajita de voz (`/?mini=voz`, miniVoice.js) abajo a la derecha y siempre encima.
 * Si ya está abierta, solo la trae al frente.
 */
async function openVoiceBox(url: string): Promise<void> {
	const title = `${getState().name || "Aku"} (voz)`;
	if (await pinWindowToCorner(title, VOICE_BOX.width, VOICE_BOX.height).catch(() => false)) return;
	// Con Chrome si está: su dictado funciona donde el de Edge da error "network".
	openAppWindow(`${url}/?mini=voz`, VOICE_BOX, "chrome");
	await pinWindowToCorner(title, VOICE_BOX.width, VOICE_BOX.height, 10_000).catch(() => false);
}

/** La segunda línea de la cabecera del menú de la bandeja; se repasa por si cambias de modelo. */
function paintTrayStatus(): void {
	try {
		setTrayStatus(`Encendido · ${resolveLLMSettings().model}`);
	} catch {
		setTrayStatus("Encendido");
	}
}

/**
 * Aku.exe con doble clic se vuelve a lanzar en segundo plano, sin consola, y esta se cierra:
 * se maneja con el ícono de la bandeja. Lo que escribiría en la consola va a `aku.log` en la carpeta de datos.
 * `SHIRO_BACKGROUND` evita que el de segundo plano se vuelva a lanzar a sí mismo.
 */
function relaunchInBackground(argv: string[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	const log = join(DATA_DIR, "aku.log");
	const fd = openSync(log, "w");
	try {
		const child = spawn(process.execPath, ["app", ...argv], {
			detached: true,
			windowsHide: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, SHIRO_BACKGROUND: "1" },
		});
		child.unref();
	} finally {
		closeSync(fd);
	}
	console.log(`  Aku sigue en segundo plano: búscalo en la bandeja, junto al reloj. Registro: ${log}`);
}

/** Acceso directo en el escritorio que abre Aku.exe, o ejecuta `npm run app` en esta carpeta. */
async function createDesktopShortcut(): Promise<void> {
	if (!IS_WINDOWS) {
		console.log("  El acceso directo solo se crea automáticamente en Windows.");
		return;
	}
	const cacheDir = join(DATA_DIR, "cache");
	mkdirSync(cacheDir, { recursive: true });
	// La imagen del icono: dentro del .exe no es un archivo, así que se copia a la caché.
	const png = join(cacheDir, "aku-icon.png");
	const pngData = readAppFile("public/Aku.png");
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
$shell = New-Object -ComObject WScript.Shell
# El de antes del cambio de nombre (Shiro.lnk) se quita, pero solo si abre lo mismo que este.
$old = Join-Path $desktop 'Shiro.lnk'
if ((Test-Path $old) -and ($shell.CreateShortcut($old).WorkingDirectory -eq $env:SHIRO_A_DIR)) { Remove-Item $old }
$path = Join-Path $desktop 'Aku.lnk'
$lnk = $shell.CreateShortcut($path)
$lnk.TargetPath = $env:SHIRO_A_TARGET
$lnk.Arguments = [string]$env:SHIRO_A_ARGS
$lnk.WorkingDirectory = $env:SHIRO_A_DIR
$lnk.WindowStyle = 7
$lnk.IconLocation = $env:SHIRO_A_ICO
$lnk.Description = 'Aku, tu asistente'
$lnk.Save()
$path`,
		{
			png,
			ico: join(cacheDir, "aku.ico"),
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
	// Aku.exe: sin consola, en segundo plano; se abre y se apaga desde el ícono de la bandeja.
	if (IS_EXE && IS_WINDOWS && !process.env.SHIRO_BACKGROUND) {
		relaunchInBackground(argv.filter((a) => !a.startsWith("--acceso") && a !== "--shortcut"));
		return;
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
			console.log("  Aku ya estaba en marcha: abro su ventana.");
			await showAppWindow(localUrl);
			return;
		}
		if (!(await stopOutdatedServer(localUrl, running))) {
			// Con el .exe suele ser otro Shiro (p. ej. el de npm run dev) usando el mismo puerto.
			const which = IS_EXE ? `otro Aku en el puerto ${PORT} (por ejemplo, el de npm run dev)` : "un Aku de antes de la última actualización";
			console.log(
				`\n  Hay ${which} y no puedo cerrarlo yo. Abro ese.` +
					`\n  Para usar este, ciérralo (Ctrl+C en su consola, o cierra esa ventana) y vuelve a ejecutar: ${OPEN_AGAIN}\n`,
			);
			openAppWindow(localUrl);
			return;
		}
		console.log("  Había un Aku de antes de la última actualización: lo cerré y abro el nuevo.");
	}
	const { serverReady, quitServer } = await import("./server.js");
	const url = await serverReady;
	openAppWindow(url);
	paintTrayStatus();
	setInterval(paintTrayStatus, 15_000).unref();
	startTray({
		open: () => void showAppWindow(url),
		talk: () => void openVoiceBox(url),
		newchat: () => void newChatWindow(url),
		// Ajustes → General, donde se busca la versión nueva y se actualiza (siempre en una ventana nueva, para que se vea).
		update: () => openAppWindow(`${url.replace(/\/+$/, "")}/?actualizar=1`),
		quit: quitServer,
	});
	console.log(
		"\n  Aku está abierto en su ventana y en la bandeja, junto al reloj. Si cierras la ventana sigue funcionando:" +
			`\n  haz clic en su ícono para volver. Para apagarlo: clic derecho en el ícono → Salir de Aku${process.env.SHIRO_BACKGROUND ? "" : " (o cierra esta consola)"}.\n`,
	);
}
