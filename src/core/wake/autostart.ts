/**
 * Arrancar Aku con Windows (lo enciende el modo asistente de Ajustes → Voz): un valor «Aku» en
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run, solo para este usuario. Arranca con `--bandeja`:
 * sin abrir la ventana, solo el ícono de la bandeja y la escucha de «Aku».
 * Con el .exe es el propio Aku.exe; desde el código, un PowerShell oculto que ejecuta `npm run app` en la
 * carpeta del proyecto. Se escribe con `reg.exe` y argumentos (nunca con un intérprete de comandos).
 */
import { execFile } from "node:child_process";
import { APP_DIR, IS_EXE } from "../../runtime.js";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE = "Aku";

/** La orden que Windows ejecuta al iniciar sesión. */
export function autostartCommand(exe = IS_EXE, execPath = process.execPath, dir = APP_DIR): string {
	if (exe) return `"${execPath}" --bandeja`;
	const quoted = dir.replace(/'/g, "''");
	return `powershell.exe -NoProfile -WindowStyle Hidden -Command "Set-Location -LiteralPath '${quoted}'; npm run app -- --bandeja"`;
}

function reg(args: string[]): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile("reg.exe", args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout) }));
	});
}

/** Pone o quita Aku del inicio de Windows. Fuera de Windows no hace nada. */
export async function setAutostart(enabled: boolean): Promise<boolean> {
	if (process.platform !== "win32") return false;
	if (enabled) return (await reg(["add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", autostartCommand(), "/f"])).ok;
	if (!(await isAutostartOn())) return true;
	return (await reg(["delete", RUN_KEY, "/v", VALUE, "/f"])).ok;
}

export async function isAutostartOn(): Promise<boolean> {
	if (process.platform !== "win32") return false;
	return (await reg(["query", RUN_KEY, "/v", VALUE])).ok;
}
