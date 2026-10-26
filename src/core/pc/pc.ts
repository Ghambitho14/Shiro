/**
 * Control del PC (Windows). Cada función hace una sola cosa y devuelve un texto claro
 * para el modelo. Los errores se lanzan como PcError con un mensaje para el usuario.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { cpus, freemem, homedir, hostname, totalmem, uptime, version } from "node:os";
import { extname, join, resolve } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { parseKeySequence } from "./keys.js";
import { IS_WINDOWS, PcError, requireWindows, runNative, runPowerShell } from "./powershell.js";

export { PcError };

export const SCREENSHOT_DIR = join(DATA_DIR, "screenshots");
const MAX_SCREENSHOTS = 30;
const SCREENSHOT_MAX_WIDTH = 1920;

function norm(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<string> {
	return new Promise((res, rej) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
			if (err) return rej(new PcError(String(stderr || err.message).trim().split("\n")[0]));
			res(String(stdout).trim());
		});
	});
}

/** Lanza un proceso sin esperar a que termine (para apagar, suspender, etc. con un pequeño margen). */
function runDetached(file: string, args: string[]): void {
	const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
}

function parseJson<T>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new PcError("Respuesta inesperada de Windows.");
	}
}

function asArray<T>(v: T | T[] | null | undefined): T[] {
	if (v === null || v === undefined) return [];
	return Array.isArray(v) ? v : [v];
}

// ─────────────────────────── Abrir apps, webs, carpetas y archivos ───────────────────────────

const EXECUTABLE_EXT = new Set([
	".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh",
	".msi", ".msc", ".scr", ".cpl", ".lnk", ".hta", ".jar", ".reg", ".pif", ".appref-ms", ".url",
]);

/** TLDs habituales: "youtube.com" es una web, "informe.pdf" no. */
const COMMON_TLDS = new Set(
	"com net org io dev app ai co es mx cl ar pe uy ve ec bo py cr gt hn sv ni pa do cu us uk de fr it pt br tv me info edu gov xyz gg ly so to fm tech site online store blog news live video music cloud jp cn ru in eu ca au nz ch nl be se no fi dk pl".split(" "),
);

/** Esquemas que solo abren apps conocidas sin ejecutar nada arbitrario. */
const SAFE_SCHEMES = new Set(["mailto", "ms-settings", "ms-windows-store", "spotify", "ms-screenclip", "calculator"]);

const FOLDERS: Record<string, [shellPath: string, label: string]> = {};
const addFolder = (names: string[], shellPath: string, label: string) => names.forEach((n) => (FOLDERS[n] = [shellPath, label]));
addFolder(["descargas", "downloads"], "shell:Downloads", "Descargas");
addFolder(["documentos", "documents"], "shell:Personal", "Documentos");
addFolder(["escritorio", "desktop"], "shell:Desktop", "Escritorio");
addFolder(["imagenes", "fotos", "pictures"], "shell:My Pictures", "Imágenes");
addFolder(["musica", "music"], "shell:My Music", "Música");
addFolder(["videos", "video"], "shell:My Video", "Vídeos");
addFolder(["carpeta personal", "home", "usuario", "perfil"], "shell:Profile", "Carpeta personal");
addFolder(["papelera", "papelera de reciclaje", "recycle bin"], "shell:RecycleBinFolder", "Papelera");
addFolder(["este equipo", "este pc", "mi pc", "mi equipo", "mi computadora", "this pc"], "shell:MyComputerFolder", "Este equipo");

/** Programas del sistema: se lanzan directamente, sin depender del idioma de Windows. */
const SYSTEM_APPS: Record<string, [command: string, label: string]> = {};
const addApp = (names: string[], command: string, label: string) => names.forEach((n) => (SYSTEM_APPS[n] = [command, label]));
addApp(["calculadora", "calculator", "calc"], "calc.exe", "Calculadora");
addApp(["bloc de notas", "notepad"], "notepad.exe", "Bloc de notas");
addApp(["paint", "mspaint"], "mspaint.exe", "Paint");
addApp(["explorador", "explorador de archivos", "explorador de windows", "file explorer", "explorer", "archivos"], "explorer.exe", "Explorador de archivos");
addApp(["administrador de tareas", "task manager", "taskmgr"], "taskmgr.exe", "Administrador de tareas");
addApp(["panel de control", "control panel"], "control.exe", "Panel de control");
addApp(["configuracion", "configuracion de windows", "ajustes", "settings"], "ms-settings:", "Configuración");
addApp(["tienda", "microsoft store", "store"], "ms-windows-store:", "Microsoft Store");
addApp(["cmd", "simbolo del sistema", "command prompt"], "cmd.exe", "Símbolo del sistema");
addApp(["powershell"], "powershell.exe", "PowerShell");

/** Nombres informales → nombre real de la app en el menú Inicio. */
const APP_NAMES: Record<string, string> = {
	vscode: "visual studio code",
	"vs code": "visual studio code",
	word: "word",
	whatsapp: "whatsapp",
	edge: "microsoft edge",
	chrome: "google chrome",
	navegador: "microsoft edge",
	correo: "outlook",
	terminal: "terminal",
};

function stripArticles(n: string): string {
	return n.replace(/^(la |el |los |las |mi |mis |una |un )+/, "").replace(/^(app|aplicacion|programa|carpeta)( de)? /, "");
}

export type OpenTarget =
	| { kind: "url"; value: string }
	| { kind: "uri"; value: string; scheme: string; safe: boolean }
	| { kind: "folder"; value: string; label: string }
	| { kind: "path"; value: string; executable: boolean; remote: boolean }
	| { kind: "system"; value: string; label: string }
	| { kind: "app"; value: string };

/** Decide qué es lo que se quiere abrir. No toca el sistema (sirve para pedir permiso antes). */
export function classifyOpenTarget(raw: string): OpenTarget {
	const target = raw.trim().replace(/^["']+|["']+$/g, "");
	if (/^https?:\/\//i.test(target)) return { kind: "url", value: target };

	const domain = /^(www\.)?([a-z0-9-]+\.)+([a-z]{2,})(:\d+)?(\/\S*)?$/i.exec(target);
	if (domain && COMMON_TLDS.has(domain[3].toLowerCase()) && !/\s/.test(target)) {
		return { kind: "url", value: `https://${target}` };
	}

	const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(target);
	if (scheme) {
		const s = scheme[1].toLowerCase();
		return { kind: "uri", value: target, scheme: s, safe: SAFE_SCHEMES.has(s) };
	}

	const n = norm(target);
	const bare = stripArticles(n);
	const folder = FOLDERS[n] ?? FOLDERS[bare];
	if (folder) return { kind: "folder", value: folder[0], label: folder[1] };

	if (/^[a-z]:[\\/]?/i.test(target) || target.startsWith("\\\\") || target.startsWith("~") || /[\\/]/.test(target)) {
		const expanded = target.startsWith("~") ? join(homedir(), target.slice(1)) : target;
		const full = resolve(homedir(), expanded);
		return {
			kind: "path",
			value: full,
			executable: EXECUTABLE_EXT.has(extname(full).toLowerCase()),
			remote: full.startsWith("\\\\"),
		};
	}

	const sys = SYSTEM_APPS[n] ?? SYSTEM_APPS[bare];
	if (sys) return { kind: "system", value: sys[0], label: sys[1] };

	return { kind: "app", value: APP_NAMES[bare] ?? bare };
}

const NORM_PS = String.raw`
function Norm([string]$s) {
	if (-not $s) { return '' }
	$d = $s.Normalize([Text.NormalizationForm]::FormD)
	$sb = New-Object Text.StringBuilder
	foreach ($c in $d.ToCharArray()) {
		if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($c) -ne [Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($c) }
	}
	return ($sb.ToString().ToLowerInvariant() -replace '\s+', ' ').Trim()
}`;

const FIND_APP_PS = String.raw`
${NORM_PS}
$q = Norm $env:SHIRO_A_NAME
$best = $null; $bestScore = 0
$all = @(Get-StartApps)
foreach ($a in $all) {
	$n = Norm $a.Name
	if (-not $n) { continue }
	if (($n -match 'desinstal|uninstall') -and -not ($q -match 'desinstal|uninstall')) { continue }
	$diff = [Math]::Min(150, [Math]::Abs($n.Length - $q.Length))
	$words = $n.Split(' ')
	$score = 0
	if ($n -eq $q) { $score = 1000 }
	elseif ($words -contains $q) { $score = 800 - $diff }
	elseif ($n.StartsWith($q)) { $score = 600 - $diff }
	elseif ((' ' + $n).Contains(' ' + $q)) { $score = 500 - $diff }
	elseif ($q.Length -ge 3 -and $n.Contains($q)) { $score = 300 - $diff }
	elseif ($q.Length -ge 4 -and $n.Length -ge 4 -and $q.Contains($n)) { $score = 200 - $diff }
	if ($score -gt $bestScore) { $bestScore = $score; $best = $a }
}
if ($best) {
	if ($env:SHIRO_A_DRY -ne '1') { Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $best.AppID) }
	@{ found = $true; name = $best.Name } | ConvertTo-Json -Compress
	return
}
$launched = $false
if ($env:SHIRO_A_DRY -ne '1') {
	try { Start-Process -FilePath $env:SHIRO_A_NAME; $launched = $true } catch { }
}
$hints = @()
foreach ($w in $q.Split(' ')) {
	if ($w.Length -lt 3) { continue }
	$hints += @($all | Where-Object { (Norm $_.Name).Contains($w) } | Select-Object -First 5 -ExpandProperty Name)
}
@{ found = $launched; name = $env:SHIRO_A_NAME; hints = @($hints | Select-Object -Unique -First 6) } | ConvertTo-Json -Compress`;

type FindAppResult = { found: boolean; name: string; hints?: string[] };

/** Busca una app instalada por nombre (y la abre salvo en modo prueba). */
export async function findAndLaunchApp(name: string, dryRun = false): Promise<FindAppResult> {
	const out = await runPowerShell(FIND_APP_PS, { name, dry: dryRun ? "1" : "0" }, 25_000);
	const r = parseJson<FindAppResult>(out);
	return { ...r, hints: asArray(r.hints) };
}

function openWithDefault(target: string): Promise<string> {
	if (IS_WINDOWS) return run("rundll32.exe", ["url.dll,FileProtocolHandler", target]);
	return run(process.platform === "darwin" ? "open" : "xdg-open", [target]);
}

export async function openTarget(raw: string): Promise<string> {
	const t = classifyOpenTarget(raw);
	switch (t.kind) {
		case "url":
			await openWithDefault(t.value);
			return `Abrí ${t.value} en el navegador.`;
		case "uri":
			await openWithDefault(t.value);
			return `Abrí ${t.value}.`;
		case "folder":
			requireWindows();
			runDetached("explorer.exe", [t.value]);
			return `Abrí la carpeta ${t.label}.`;
		case "path": {
			if (!existsSync(t.value)) throw new PcError(`No existe: ${t.value}`);
			if (IS_WINDOWS) {
				await runPowerShell("Start-Process -FilePath $env:SHIRO_A_PATH", { path: t.value });
			} else {
				await openWithDefault(t.value);
			}
			return `Abrí ${t.value}.`;
		}
		case "system":
			requireWindows();
			if (t.value.endsWith(":")) await openWithDefault(t.value);
			else await runPowerShell("Start-Process -FilePath $env:SHIRO_A_CMD", { cmd: t.value });
			return `Abrí ${t.label}.`;
		case "app": {
			if (!IS_WINDOWS) {
				if (process.platform === "darwin") await run("open", ["-a", t.value]);
				else runDetached(t.value, []);
				return `Abrí ${t.value}.`;
			}
			const r = await findAndLaunchApp(t.value);
			if (r.found) return `Abrí ${r.name}.`;
			const hints = r.hints?.length ? ` Apps instaladas parecidas: ${r.hints.join(", ")}.` : "";
			throw new PcError(`No encontré ninguna aplicación llamada "${raw}".${hints}`);
		}
	}
}

// ─────────────────────────── Captura de pantalla ───────────────────────────

/** Escala de la última captura: coordenadas de la imagen × escala = píxeles reales. */
let lastShotScale = 1;

function pruneScreenshots(): void {
	try {
		const files = readdirSync(SCREENSHOT_DIR)
			.filter((f) => f.endsWith(".jpg"))
			.map((f) => ({ f, t: statSync(join(SCREENSHOT_DIR, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		for (const { f } of files.slice(MAX_SCREENSHOTS)) unlinkSync(join(SCREENSHOT_DIR, f));
	} catch {
		/* limpiar es opcional */
	}
}

export type Screenshot = { path: string; file: string; width: number; height: number; screenWidth: number; screenHeight: number };

export async function takeScreenshot(): Promise<Screenshot> {
	requireWindows();
	mkdirSync(SCREENSHOT_DIR, { recursive: true });
	const file = `captura-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;
	const path = join(SCREENSHOT_DIR, file);
	const out = await runNative("[ShiroPc.Screenshot]::Take($env:SHIRO_A_OUT, [int]$env:SHIRO_A_MAXW, 80)", {
		out: path,
		maxW: SCREENSHOT_MAX_WIDTH,
	});
	const r = parseJson<{ sw: number; sh: number; w: number; h: number }>(out);
	lastShotScale = r.w > 0 ? r.sw / r.w : 1;
	pruneScreenshots();
	return { path, file, width: r.w, height: r.h, screenWidth: r.sw, screenHeight: r.sh };
}

// ─────────────────────────── Ratón ───────────────────────────

export type MouseAction = "click" | "double_click" | "right_click" | "move" | "scroll_up" | "scroll_down";

export async function mouseAction(action: MouseAction, x?: number, y?: number, amount = 3): Promise<string> {
	requireWindows();
	const hasPoint = typeof x === "number" && typeof y === "number";
	const rx = hasPoint ? Math.round(x! * lastShotScale) : undefined;
	const ry = hasPoint ? Math.round(y! * lastShotScale) : undefined;
	if (action === "move" && !hasPoint) throw new PcError("Para mover el ratón indica x e y.");
	await runNative(
		String.raw`
[ShiroPc.Input]::DpiAware()
if ($env:SHIRO_A_X) { [ShiroPc.Input]::Move([int]$env:SHIRO_A_X, [int]$env:SHIRO_A_Y); Start-Sleep -Milliseconds 80 }
switch ($env:SHIRO_A_ACTION) {
	'click' { [ShiroPc.Input]::Click('left', 1) }
	'double_click' { [ShiroPc.Input]::Click('left', 2) }
	'right_click' { [ShiroPc.Input]::Click('right', 1) }
	'scroll_up' { [ShiroPc.Input]::Scroll([int]$env:SHIRO_A_AMOUNT) }
	'scroll_down' { [ShiroPc.Input]::Scroll(-[int]$env:SHIRO_A_AMOUNT) }
}`,
		{ action, x: rx, y: ry, amount: Math.max(1, Math.min(30, Math.round(amount))) },
	);
	const where = hasPoint ? ` en (${x}, ${y})` : "";
	const labels: Record<MouseAction, string> = {
		click: "Hice clic",
		double_click: "Hice doble clic",
		right_click: "Hice clic derecho",
		move: "Moví el ratón",
		scroll_up: "Desplacé hacia arriba",
		scroll_down: "Desplacé hacia abajo",
	};
	return `${labels[action]}${where}.`;
}

// ─────────────────────────── Ventanas ───────────────────────────

const WINDOWS_PS = String.raw`
${NORM_PS}
function Get-Wins {
	$procs = @{}
	foreach ($p in Get-Process) { $procs[$p.Id] = $p.ProcessName }
	foreach ($line in [ShiroPc.Windows]::List()) {
		$parts = $line.Split('|', 3)
		[pscustomobject]@{ Id = [long]$parts[0]; App = [string]$procs[[int]$parts[1]]; Title = $parts[2] }
	}
}
function Find-Win([string]$query, [switch]$SkipSelf) {
	$q = Norm $query
	if (-not $q) { return $null }
	$best = $null; $bestScore = 0
	foreach ($w in Get-Wins) {
		$t = Norm $w.Title; $a = Norm $w.App
		if ($SkipSelf -and $t.StartsWith((Norm $env:SHIRO_A_SELF)) -and -not $q.Contains((Norm $env:SHIRO_A_SELF))) { continue }
		$s = 0
		if ($a -eq $q -or $t -eq $q) { $s = 1000 }
		elseif ($a.StartsWith($q)) { $s = 700 }
		elseif ($t.Contains($q)) { $s = 600 - [Math]::Min(200, $t.Length) }
		elseif ($a.Contains($q)) { $s = 300 }
		if ($s -gt $bestScore) { $bestScore = $s; $best = $w }
	}
	return $best
}
function Wait-Win([string]$query) {
	for ($i = 0; $i -lt 8; $i++) {
		$w = Find-Win $query -SkipSelf
		if ($w) { return $w }
		Start-Sleep -Milliseconds 600
	}
	throw "No encontré ninguna ventana abierta que coincida con '$query'."
}`;

export type WindowAction = "list" | "focus" | "minimize" | "maximize" | "restore" | "close" | "show_desktop";
type WindowInfo = { app: string; title: string; active?: boolean };

export async function windowAction(action: WindowAction, title?: string, selfName = "Shiro"): Promise<string> {
	requireWindows();
	if (action === "list") {
		const out = await runNative(
			`${WINDOWS_PS}
$fg = [ShiroPc.Windows]::Foreground()
@(Get-Wins | ForEach-Object { [pscustomobject]@{ app = $_.App; title = $_.Title; active = ($_.Id -eq $fg) } }) | ConvertTo-Json -Compress`,
		);
		const wins = asArray(out ? parseJson<WindowInfo | WindowInfo[]>(out) : []);
		if (!wins.length) return "No hay ventanas abiertas.";
		return "Ventanas abiertas:\n" + wins.map((w) => `- ${w.title} (${w.app})${w.active ? " ← activa" : ""}`).join("\n");
	}
	if (action === "show_desktop") {
		await runPowerShell("(New-Object -ComObject Shell.Application).MinimizeAll()");
		return "Minimicé todas las ventanas.";
	}
	if (!title?.trim()) throw new PcError("Indica qué ventana (por ejemplo: 'Spotify', 'Chrome', 'Bloc de notas').");
	const out = await runNative(
		`${WINDOWS_PS}
$w = Wait-Win $env:SHIRO_A_TITLE
switch ($env:SHIRO_A_ACTION) {
	'focus' { [void][ShiroPc.Windows]::Focus($w.Id) }
	'minimize' { [ShiroPc.Windows]::Show($w.Id, 6) }
	'maximize' { [ShiroPc.Windows]::Show($w.Id, 3); [void][ShiroPc.Windows]::Focus($w.Id) }
	'restore' { [ShiroPc.Windows]::Show($w.Id, 9); [void][ShiroPc.Windows]::Focus($w.Id) }
	'close' { [ShiroPc.Windows]::Close($w.Id) }
}
@{ app = $w.App; title = $w.Title } | ConvertTo-Json -Compress`,
		{ action, title, self: selfName },
	);
	const w = parseJson<WindowInfo>(out);
	const verbs: Record<string, string> = {
		focus: "Traje al frente",
		minimize: "Minimicé",
		maximize: "Maximicé",
		restore: "Restauré",
		close: "Cerré",
	};
	return `${verbs[action]} la ventana "${w.title}" (${w.app}).`;
}

// ─────────────────────────── Teclado ───────────────────────────

export async function keyboardAction(opts: { text?: string; keys?: string; window?: string }, selfName = "Shiro"): Promise<string> {
	requireWindows();
	const text = opts.text ?? "";
	const keys = opts.keys?.trim() ?? "";
	if (!text && !keys) throw new PcError("Indica el texto a escribir (text) o las teclas a pulsar (keys).");
	let combos = "";
	if (keys) {
		try {
			combos = parseKeySequence(keys)
				.map((c) => c.vks.join(","))
				.join(";");
		} catch (err) {
			throw new PcError(err instanceof Error ? err.message : String(err));
		}
	}
	const out = await runNative(
		`${WINDOWS_PS}
$target = $null
if ($env:SHIRO_A_WINDOW) {
	$target = Wait-Win $env:SHIRO_A_WINDOW
	[void][ShiroPc.Windows]::Focus($target.Id)
	Start-Sleep -Milliseconds 250
}
if ($env:SHIRO_A_TEXT) { [ShiroPc.Input]::Type($env:SHIRO_A_TEXT) }
if ($env:SHIRO_A_COMBOS) {
	foreach ($c in $env:SHIRO_A_COMBOS.Split(';')) {
		[ShiroPc.Input]::Combo([int[]]($c.Split(',')))
		Start-Sleep -Milliseconds 120
	}
}
if ($target) { $target.Title }`,
		{ text: text || undefined, combos: combos || undefined, window: opts.window?.trim() || undefined, self: selfName },
		30_000,
	);
	const where = out ? ` en "${out}"` : "";
	const parts: string[] = [];
	if (text) parts.push(`Escribí ${text.length} caracteres${where}`);
	if (keys) parts.push(`pulsé ${keys}${text ? "" : where}`);
	const msg = parts.join(" y ");
	return msg.charAt(0).toUpperCase() + msg.slice(1) + ".";
}

// ─────────────────────────── Multimedia y volumen ───────────────────────────

export type MediaAction = "volume_up" | "volume_down" | "set_volume" | "get_volume" | "mute" | "unmute" | "play_pause" | "next" | "previous" | "stop";

export async function mediaAction(action: MediaAction, value?: number): Promise<string> {
	requireWindows();
	const step = Math.max(1, Math.min(100, Math.round(value ?? 10)));
	if (action === "set_volume" && (value === undefined || Number.isNaN(value))) throw new PcError("Indica el volumen (0 a 100).");
	const out = await runNative(
		String.raw`
$v = [int]$env:SHIRO_A_VALUE
switch ($env:SHIRO_A_ACTION) {
	'volume_up' { [ShiroPc.Audio]::SetMute($false); [ShiroPc.Audio]::SetVolume([ShiroPc.Audio]::GetVolume() + $v) }
	'volume_down' { [ShiroPc.Audio]::SetVolume([ShiroPc.Audio]::GetVolume() - $v) }
	'set_volume' { [ShiroPc.Audio]::SetMute($false); [ShiroPc.Audio]::SetVolume($v) }
	'mute' { [ShiroPc.Audio]::SetMute($true) }
	'unmute' { [ShiroPc.Audio]::SetMute($false) }
	'play_pause' { [ShiroPc.Input]::Combo(@(0xB3)) }
	'next' { [ShiroPc.Input]::Combo(@(0xB0)) }
	'previous' { [ShiroPc.Input]::Combo(@(0xB1)) }
	'stop' { [ShiroPc.Input]::Combo(@(0xB2)) }
}
try { @{ volume = [ShiroPc.Audio]::GetVolume(); muted = [ShiroPc.Audio]::GetMute() } | ConvertTo-Json -Compress } catch { '{}' }`,
		{ action, value: action === "set_volume" ? Math.max(0, Math.min(100, Math.round(value!))) : step },
	);
	const s = parseJson<{ volume?: number; muted?: boolean }>(out || "{}");
	const status = typeof s.volume === "number" ? ` Volumen actual: ${s.volume}%${s.muted ? " (silenciado)" : ""}.` : "";
	const done: Record<MediaAction, string> = {
		volume_up: "Subí el volumen.",
		volume_down: "Bajé el volumen.",
		set_volume: "Ajusté el volumen.",
		get_volume: "",
		mute: "Silencié el sonido.",
		unmute: "Quité el silencio.",
		play_pause: "Pulsé reproducir/pausa.",
		next: "Pasé a la siguiente pista.",
		previous: "Volví a la pista anterior.",
		stop: "Detuve la reproducción.",
	};
	return (done[action] + status).trim() || "No hay dispositivo de audio disponible.";
}

// ─────────────────────────── Procesos ───────────────────────────

/** Procesos que nunca se cierran: romperían Windows (o a Shiro mismo). */
const PROTECTED_PROCESSES = new Set([
	"system", "idle", "registry", "smss", "csrss", "wininit", "winlogon", "services", "lsass", "lsaiso",
	"svchost", "dwm", "fontdrvhost", "memory compression", "secure system", "node", "powershell", "conhost",
]);

export async function processAction(action: "list" | "kill", name?: string): Promise<string> {
	requireWindows();
	if (action === "list") {
		const out = await runPowerShell(
			String.raw`
$ps = Get-Process
if ($env:SHIRO_A_NAME) { $ps = $ps | Where-Object { $_.ProcessName -like ('*' + $env:SHIRO_A_NAME + '*') } }
@($ps | Group-Object ProcessName | ForEach-Object {
	[pscustomobject]@{ name = $_.Name; count = $_.Count; mb = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) }
} | Sort-Object mb -Descending | Select-Object -First 20) | ConvertTo-Json -Compress`,
			{ name: name?.replace(/[*?[\]]/g, "") || undefined },
		);
		const list = asArray(out ? parseJson<{ name: string; count: number; mb: number } | { name: string; count: number; mb: number }[]>(out) : []);
		if (!list.length) return name ? `No hay procesos que coincidan con "${name}".` : "No hay procesos.";
		return (
			"Procesos (más memoria primero):\n" +
			list.map((p) => `- ${p.name}${p.count > 1 ? ` ×${p.count}` : ""}: ${p.mb} MB`).join("\n")
		);
	}
	const clean = (name ?? "").trim().replace(/\.exe$/i, "");
	if (!clean || !/^[\w .()+-]+$/.test(clean)) throw new PcError("Indica el nombre exacto del proceso (por ejemplo: chrome, spotify).");
	if (PROTECTED_PROCESSES.has(clean.toLowerCase())) throw new PcError(`No cierro "${clean}": es un proceso del sistema o del propio Shiro.`);
	const out = await runPowerShell(
		String.raw`
$ps = @(Get-Process | Where-Object { $_.ProcessName -eq $env:SHIRO_A_NAME })
if ($ps.Count -eq 0) { throw ("No hay ningún proceso llamado '" + $env:SHIRO_A_NAME + "' abierto.") }
$ps | Stop-Process -Force
$ps.Count`,
		{ name: clean },
	);
	return `Cerré ${out} proceso(s) de ${clean}.`;
}

// ─────────────────────────── Portapapeles ───────────────────────────

export async function clipboardAction(action: "read" | "write", text?: string): Promise<string> {
	requireWindows();
	if (action === "write") {
		if (!text) throw new PcError("Indica el texto a copiar.");
		await runPowerShell("Set-Clipboard -Value $env:SHIRO_A_TEXT", { text });
		return `Copié ${text.length} caracteres al portapapeles.`;
	}
	const out = await runPowerShell("$t = Get-Clipboard -Raw -Format Text; if ($null -ne $t) { $t }");
	if (!out) return "El portapapeles está vacío (o no contiene texto).";
	return out.length > 8000 ? `${out.slice(0, 8000)}\n[… recortado: ${out.length} caracteres]` : out;
}

// ─────────────────────────── Estado del equipo ───────────────────────────

async function cpuUsagePercent(sampleMs = 400): Promise<number> {
	const snap = () => cpus().map((c) => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b, 0) }));
	const a = snap();
	await new Promise((r) => setTimeout(r, sampleMs));
	const b = snap();
	let idle = 0;
	let total = 0;
	b.forEach((c, i) => {
		idle += c.idle - a[i].idle;
		total += c.total - a[i].total;
	});
	return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function gb(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

function formatUptime(sec: number): string {
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return [d ? `${d} d` : "", h ? `${h} h` : "", `${m} min`].filter(Boolean).join(" ");
}

export async function systemInfo(): Promise<string> {
	const [cpu, extra] = await Promise.all([
		cpuUsagePercent(),
		IS_WINDOWS
			? runPowerShell(
					String.raw`
$d = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { @{ drive = $_.DeviceID; free = [double]$_.FreeSpace; size = [double]$_.Size } })
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$bat = $null
if ($b) { $bat = @{ percent = [int]$b.EstimatedChargeRemaining; plugged = ($b.BatteryStatus -eq 2) } }
@{ disks = $d; battery = $bat } | ConvertTo-Json -Compress -Depth 4`,
				)
					.then((o) => parseJson<{ disks?: { drive: string; free: number; size: number }[]; battery?: { percent: number; plugged: boolean } | null }>(o))
					.catch(() => null)
			: Promise.resolve(null),
	]);
	const total = totalmem();
	const used = total - freemem();
	const cpuInfo = cpus();
	const lines = [
		`Equipo: ${hostname()} · ${version()}`,
		`Procesador: ${cpuInfo[0]?.model.trim() ?? "?"} (${cpuInfo.length} hilos) · uso ${cpu}%`,
		`Memoria RAM: ${gb(used)} de ${gb(total)} GB en uso (${Math.round((used / total) * 100)}%)`,
		`Encendido desde hace: ${formatUptime(uptime())}`,
	];
	for (const d of asArray(extra?.disks)) {
		if (!d.size) continue;
		lines.push(`Disco ${d.drive}: ${gb(d.free)} GB libres de ${gb(d.size)} GB`);
	}
	if (extra?.battery) lines.push(`Batería: ${extra.battery.percent}%${extra.battery.plugged ? " (conectado a la corriente)" : " (usando batería)"}`);
	return lines.join("\n");
}

// ─────────────────────────── Energía ───────────────────────────

export type PowerAction = "lock" | "sleep" | "shutdown" | "restart" | "logoff" | "cancel";

export async function powerAction(action: PowerAction, delayMinutes?: number): Promise<string> {
	requireWindows();
	const minutes = Math.max(0, Math.min(24 * 60, Math.round(delayMinutes ?? 1)));
	const seconds = String(minutes * 60);
	const when = minutes === 0 ? "ahora" : `en ${minutes} minuto${minutes === 1 ? "" : "s"}`;
	switch (action) {
		case "lock":
			runDetached("rundll32.exe", ["user32.dll,LockWorkStation"]);
			return "Bloqueé el equipo.";
		case "sleep":
			// Unos segundos de margen para que la respuesta llegue antes de suspender.
			runDetached("powershell.exe", [
				"-NoProfile",
				"-Command",
				"Start-Sleep -Seconds 3; Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)",
			]);
			return "Suspendo el equipo en 3 segundos.";
		case "shutdown":
			await run("shutdown.exe", ["/s", "/t", seconds, "/c", "Shiro: apagado programado"]);
			return `El equipo se apagará ${when}. Para evitarlo, pide cancelar el apagado.`;
		case "restart":
			await run("shutdown.exe", ["/r", "/t", seconds, "/c", "Shiro: reinicio programado"]);
			return `El equipo se reiniciará ${when}. Para evitarlo, pide cancelar el reinicio.`;
		case "logoff":
			runDetached("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Seconds 3; shutdown.exe /l"]);
			return "Cierro la sesión en 3 segundos.";
		case "cancel":
			try {
				await run("shutdown.exe", ["/a"]);
				return "Cancelé el apagado/reinicio programado.";
			} catch {
				return "No había ningún apagado o reinicio programado.";
			}
	}
}
