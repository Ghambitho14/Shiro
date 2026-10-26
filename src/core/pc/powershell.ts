import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { NATIVE_HELPER_SOURCE } from "./nativeHelper.js";

export const IS_WINDOWS = process.platform === "win32";

/** Error con un mensaje ya pensado para mostrar al usuario. */
export class PcError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PcError";
	}
}

export function requireWindows(): void {
	if (!IS_WINDOWS) throw new PcError("Esta acción del PC solo está disponible en Windows por ahora.");
}

type PsArgs = Record<string, string | number | boolean | undefined>;

const ERR_MARK = "SHIRO_ERR:";

/**
 * Ejecuta un script de PowerShell (Windows PowerShell 5.1, presente en todo Windows 10/11).
 *
 * Los datos que vienen del modelo NUNCA se pegan dentro del código: se pasan como variables
 * de entorno (`$env:SHIRO_A_<NOMBRE>`). Así no hay forma de inyectar comandos.
 */
export function runPowerShell(script: string, args: PsArgs = {}, timeoutMs = 20_000): Promise<string> {
	requireWindows();
	const wrapped = [
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"try {",
		script,
		`} catch { [Console]::Error.WriteLine('${ERR_MARK}' + $_.Exception.Message); exit 1 }`,
	].join("\n");
	const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(args)) {
		if (value !== undefined) env[`SHIRO_A_${key.toUpperCase()}`] = String(value);
	}
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
			{ env, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(err, stdout, stderr) => {
				if (err) {
					const marked = String(stderr)
						.split(/\r?\n/)
						.find((l) => l.startsWith(ERR_MARK));
					if (marked) return reject(new PcError(marked.slice(ERR_MARK.length).trim()));
					if ((err as { killed?: boolean }).killed) return reject(new PcError("La acción tardó demasiado y se canceló."));
					const detail = cleanStderr(String(stderr));
					if (/malintencionad|malicious/i.test(detail)) {
						return reject(new PcError("El antivirus de Windows bloqueó esta acción."));
					}
					return reject(new PcError(`PowerShell falló${detail ? `: ${detail}` : "."}`));
				}
				resolve(String(stdout).trim());
			},
		);
	});
}

/** PowerShell a veces manda los errores en formato CLIXML: se deja solo el texto útil. */
function cleanStderr(stderr: string): string {
	const text = stderr.includes("CLIXML")
		? [...stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]).join("")
		: stderr;
	return text
		.replace(/_x000D__x000A_/g, "\n")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("+") && !/^(En |At )?línea:|^At line:|CategoryInfo|FullyQualifiedErrorId/i.test(l))
		.slice(0, 2)
		.join(" ")
		.slice(0, 300);
}

let helperDll: Promise<string> | null = null;

/**
 * Compila una vez la ayuda nativa (teclado, ratón, ventanas, volumen) a una DLL en data/cache.
 * Las siguientes veces solo se carga (≈70 ms en vez de ≈600 ms).
 */
export function ensureNativeHelper(): Promise<string> {
	helperDll ??= (async () => {
		const hash = createHash("sha256").update(NATIVE_HELPER_SOURCE).digest("hex").slice(0, 12);
		const dir = join(DATA_DIR, "cache");
		const dll = join(dir, `shiro-pc-${hash}.dll`);
		if (existsSync(dll)) return dll;
		mkdirSync(dir, { recursive: true });
		const cs = join(dir, `shiro-pc-${hash}.cs`);
		writeFileSync(cs, NATIVE_HELPER_SOURCE, "utf-8");
		await runPowerShell(
			"Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:SHIRO_A_CS)) -ReferencedAssemblies System.Drawing, System.Windows.Forms -OutputAssembly $env:SHIRO_A_DLL -OutputType Library",
			{ cs, dll },
			60_000,
		);
		return dll;
	})().catch((err) => {
		helperDll = null;
		throw err;
	});
	return helperDll;
}

/** Igual que runPowerShell, pero con la ayuda nativa cargada (tipos ShiroPc.*). */
export async function runNative(script: string, args: PsArgs = {}, timeoutMs = 20_000): Promise<string> {
	const dll = await ensureNativeHelper();
	return runPowerShell(`Add-Type -Path $env:SHIRO_A_HELPERDLL\n${script}`, { ...args, helperDll: dll }, timeoutMs);
}
