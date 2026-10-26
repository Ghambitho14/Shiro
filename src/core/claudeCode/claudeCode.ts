/**
 * Claude Code (el programa `claude` de Anthropic) como ayudante de Aku para programar.
 * Se lanza sin intérprete de comandos (`spawn` con argumentos), en modo sin ventana (`-p`), y su salida
 * `stream-json` se lee línea a línea para mostrar el progreso. Usa la sesión que el usuario inició con
 * `claude` → `/login` (su suscripción): las claves de Shiro y ANTHROPIC_API_KEY no se le pasan.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { cleanEnv } from "../terminal/terminal.js";

/** Cómo lanzar Claude Code: el programa y los argumentos que van antes de los nuestros. */
export type ClaudeLauncher = { file: string; prefix: string[]; label: string };

const isFile = (p: string) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/**
 * Busca Claude Code: SHIRO_CLAUDE_PATH, el PATH, `~/.local/bin` (instalador oficial) y el de npm.
 * En Windows el de npm es un `claude.cmd`, que no se puede lanzar sin cmd.exe: se usa node + su cli.js.
 */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeLauncher | null {
	const explicit = env.SHIRO_CLAUDE_PATH?.trim();
	if (explicit && isFile(explicit)) return launcherFor(explicit, platform);
	const home = env.USERPROFILE || env.HOME || homedir();
	const dirs = [...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), join(home, ".local", "bin")];
	if (platform === "win32" && env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
	const names = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
	for (const name of names) {
		for (const dir of dirs) {
			const full = join(dir, name);
			if (!isFile(full)) continue;
			const launcher = launcherFor(full, platform);
			if (launcher) return launcher;
		}
	}
	return null;
}

function launcherFor(file: string, platform: NodeJS.Platform): ClaudeLauncher | null {
	// cli.js de npm (o un claude de prueba) se lanza con node.
	if (/\.[cm]?js$/i.test(file)) return { file: "node", prefix: [file], label: file };
	if (platform === "win32" && /\.cmd$/i.test(file)) {
		const cli = join(dirname(file), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
		return existsSync(cli) ? { file: "node", prefix: [cli], label: file } : null;
	}
	return { file, prefix: [], label: file };
}

let cached: { at: number; value: ClaudeLauncher | null } | null = null;

/** findClaudeCode con caché de un minuto (se consulta en cada mensaje para decidir si se ofrece la tool). */
export function claudeCodeLauncher(): ClaudeLauncher | null {
	if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), value: findClaudeCode() };
	return cached.value;
}

/** Argumentos de `claude` para una tarea sin ventana: puede editar archivos; los comandos, solo los que el usuario permitió. */
export function buildClaudeArgs(task: string, opts: { continue?: boolean } = {}): string[] {
	// Una tarea que empieza por «-» se tomaría por una opción.
	const prompt = task.trim().startsWith("-") ? `Tarea: ${task.trim()}` : task.trim();
	return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", ...(opts.continue ? ["--continue"] : [])];
}

export type ClaudeEvent =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; detail: string }
	| { kind: "result"; ok: boolean; text: string; costUsd?: number; turns?: number; sessionId?: string };

/** Una línea de `--output-format stream-json` → lo que interesa mostrar (o null). */
export function parseClaudeLine(line: string): ClaudeEvent[] {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return [];
	}
	if (j.type === "assistant") {
		const content = (j.message as { content?: unknown } | undefined)?.content;
		if (!Array.isArray(content)) return [];
		const out: ClaudeEvent[] = [];
		for (const b of content as Array<Record<string, unknown>>) {
			if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "text", text: b.text.trim() });
			if (b.type === "tool_use" && typeof b.name === "string") out.push({ kind: "tool", name: b.name, detail: toolDetail(b.input) });
		}
		return out;
	}
	if (j.type === "result") {
		return [
			{
				kind: "result",
				ok: j.is_error !== true && j.subtype === "success",
				text: typeof j.result === "string" ? j.result : "",
				costUsd: typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined,
				turns: typeof j.num_turns === "number" ? j.num_turns : undefined,
				sessionId: typeof j.session_id === "string" ? j.session_id : undefined,
			},
		];
	}
	return [];
}

/** Lo más útil de los argumentos de una herramienta de Claude Code (archivo, comando, búsqueda…). */
function toolDetail(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const i = input as Record<string, unknown>;
	const v = i.file_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description ?? "";
	return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 160) : "";
}

/** Los errores de Claude Code, en español y con qué hacer. */
export function explainClaudeError(text: string): string {
	const t = text.toLowerCase();
	if (/not logged in|please run \/login|invalid api key|authentication|oauth|unauthorized|401/.test(t)) {
		return "Claude Code no tiene la sesión iniciada. Abre una terminal, escribe claude y dentro /login con tu cuenta de Claude.";
	}
	if (/usage limit|rate limit|limit reached|reached your|5-hour|weekly limit|429/.test(t)) {
		return "Llegaste al límite de uso de tu plan de Claude. Vuelve a intentarlo más tarde.";
	}
	return `Claude Code falló: ${text.trim().slice(0, 600) || "sin detalles"}`;
}

/** Cierra Claude Code y lo que haya abierto (en Windows, todo el árbol de procesos). */
function killTree(proc: ChildProcess): void {
	if (process.platform === "win32" && proc.pid) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
	else proc.kill();
}

export type ClaudeRunResult = { ok: boolean; text: string; costUsd?: number; turns?: number; timedOut?: boolean };

/** Ejecuta Claude Code en `cwd` con la tarea; `onEvent` recibe el progreso. */
export function runClaudeCode(opts: {
	launcher: ClaudeLauncher;
	task: string;
	cwd: string;
	continue?: boolean;
	timeoutMs: number;
	onEvent?: (e: ClaudeEvent) => void;
	onStderr?: (text: string) => void;
	/** Para detenerlo a mitad (botón de parar del panel Terminal). */
	signal?: AbortSignal;
}): Promise<ClaudeRunResult> {
	return new Promise((resolve) => {
		const args = [...opts.launcher.prefix, ...buildClaudeArgs(opts.task, { continue: opts.continue })];
		const proc = spawn(opts.launcher.file, args, { cwd: opts.cwd, env: cleanEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		let stderr = "";
		let result: Extract<ClaudeEvent, { kind: "result" }> | null = null;
		let lastText = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(proc);
		}, opts.timeoutMs);
		let stopped = false;
		opts.signal?.addEventListener("abort", () => {
			stopped = true;
			killTree(proc);
		});
		const handle = (line: string) => {
			for (const e of parseClaudeLine(line)) {
				if (e.kind === "result") result = e;
				if (e.kind === "text") lastText = e.text;
				opts.onEvent?.(e);
			}
		};
		proc.stdout.setEncoding("utf-8");
		proc.stdout.on("data", (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) handle(line);
			}
		});
		proc.stderr.setEncoding("utf-8");
		proc.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
			opts.onStderr?.(chunk);
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, text: `No pude abrir Claude Code (${opts.launcher.label}): ${err.message}` });
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (buf.trim()) handle(buf.trim());
			const r = result as Extract<ClaudeEvent, { kind: "result" }> | null;
			if (stopped) return resolve({ ok: false, text: `Detuviste a Claude Code.${lastText ? ` Lo último que dijo: ${lastText}` : ""} Puede haber dejado cambios a medias.` });
			if (timedOut) return resolve({ ok: false, timedOut: true, text: `Claude Code tardó demasiado y lo detuve.${lastText ? ` Lo último que dijo: ${lastText}` : ""}` });
			if (r?.ok) return resolve({ ok: true, text: r.text || lastText || "(Claude Code terminó sin decir nada)", costUsd: r.costUsd, turns: r.turns });
			resolve({ ok: false, text: explainClaudeError(r?.text || stderr || lastText || `terminó con código ${code}`) });
		});
	});
}
