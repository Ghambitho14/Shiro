import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_TIMEOUT = 10000;
const MAX_TIMEOUT = 30000;
const MAX_OUTPUT_CHARS = 12000;
const BLOCKED_PATTERNS: RegExp[] = [
	/\bimport\s+subprocess\b/i,
	/\bimport\s+socket\b/i,
	/\bimport\s+shutil\b/i,
	/\bfrom\s+subprocess\b/i,
	/\bfrom\s+socket\b/i,
	/\b__import__\s*\(/i,
	/\beval\s*\(/i,
	/\bexec\s*\(/i,
	/\bos\.system\s*\(/i,
	/\bopen\s*\(/i,
];

function hasBlockedPattern(code: string): boolean {
	return BLOCKED_PATTERNS.some((re) => re.test(code));
}

function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Salida truncada por límite de seguridad]`;
}

function getPythonCandidates(): string[] {
	if (process.platform === "win32") return ["python", "python3"];
	return ["python3", "python"];
}

export async function executePython(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const code = String(args.code ?? "");
	if (!code) return { ok: false, content: "Código requerido" };
	if (hasBlockedPattern(code)) {
		return { ok: false, content: "Código bloqueado por política de seguridad de Python sandbox." };
	}
	
	const timeout = Math.min(Math.max(Number(args.timeout) || DEFAULT_TIMEOUT, 1000), MAX_TIMEOUT);
	
	const tmpDir = tmpdir();
	const scriptPath = join(tmpDir, `shiro_python_${Date.now()}.py`);
	
	try {
		writeFileSync(scriptPath, code, "utf-8");
		
		return new Promise((resolve) => {
			let settled = false;
			let proc: ReturnType<typeof spawn> | null = null;
			let stdout = "";
			let stderr = "";
			const timeoutId = setTimeout(() => {
				if (settled) return;
				proc?.kill("SIGTERM");
				setTimeout(() => proc?.kill("SIGKILL"), 1000);
				settled = true;
				resolve({
					ok: false,
					content: `Timeout después de ${timeout}ms`,
				});
			}, timeout + 1000);

			const attachHandlers = (child: ReturnType<typeof spawn>) => {
				child.stdout.on("data", (data) => {
					stdout += data.toString();
				});

				child.stderr.on("data", (data) => {
					stderr += data.toString();
				});

				child.on("error", (err) => {
					if (settled) return;
					clearTimeout(timeoutId);
					settled = true;
					resolve({
						ok: false,
						content: `Error al ejecutar Python: ${err.message}`,
					});
				});

				child.on("close", (code) => {
					if (settled) return;
					clearTimeout(timeoutId);
					settled = true;
					if (code === 0) {
						resolve({
							ok: true,
							content: truncateOutput(stdout.trim() || "(sin output)"),
						});
					} else {
						const errorMsg = stderr.trim() || `Exit code: ${code}`;
						resolve({
							ok: false,
							content: truncateOutput(errorMsg),
						});
					}
				});
			};

			const candidates = getPythonCandidates();
			let started = false;
			for (const bin of candidates) {
				try {
					proc = spawn(bin, [scriptPath], {
						env: {
							...process.env,
							PYTHONUNBUFFERED: "1",
							PYTHONDONTWRITEBYTECODE: "1",
						},
					});
					attachHandlers(proc);
					started = true;
					break;
				} catch {
					continue;
				}
			}

			if (!started || !proc) {
				clearTimeout(timeoutId);
				settled = true;
				resolve({
					ok: false,
					content: "No se encontró intérprete Python disponible (python/python3).",
				});
			}
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			content: `Error: ${msg}`,
		};
	} finally {
		try {
			if (existsSync(scriptPath)) {
				unlinkSync(scriptPath);
			}
		} catch {
		}
	}
}