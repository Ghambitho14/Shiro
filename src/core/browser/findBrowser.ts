import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Edge y Chrome instalados, en orden de preferencia para abrir la app con --app. */
function installedBrowsers(): string[] {
	const env = process.env;
	const candidates =
		process.platform === "win32"
			? [
					join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
					join(env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
					join(env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
					join(env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
					join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
				]
			: process.platform === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
				: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
	return candidates.filter((p) => p && existsSync(p));
}

/** Ruta de Edge o Chrome instalados (para abrir Shiro en su propia ventana con --app). */
export function findInstalledBrowser(): string | null {
	return installedBrowsers()[0] ?? null;
}

/** Chrome que descargó puppeteer (lo usa la conexión de WhatsApp) en ~/.cache/puppeteer. */
function puppeteerCachedChrome(): string[] {
	const dir = join(homedir(), ".cache", "puppeteer", "chrome");
	let versions: string[] = [];
	try {
		versions = readdirSync(dir).sort().reverse();
	} catch {
		return [];
	}
	const inside = ["chrome-win64/chrome.exe", "chrome-win32/chrome.exe", "chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
	return versions.flatMap((v) => inside.map((p) => join(dir, v, p))).filter((p) => existsSync(p));
}

/**
 * Navegadores para el navegador sin ventana de Shiro, en orden de prueba: Chrome primero
 * (Edge a veces se cierra al arrancar sin ventana, p. ej. con políticas de empresa).
 */
export function automationBrowsers(): string[] {
	const installed = installedBrowsers();
	const isEdge = (p: string) => /edge/i.test(p);
	return [...installed.filter((p) => !isEdge(p)), ...puppeteerCachedChrome(), ...installed.filter(isEdge)];
}
