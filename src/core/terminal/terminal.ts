/**
 * Terminal de Shiro: una PowerShell (o bash fuera de Windows) que queda abierta entre comandos,
 * compartida por el usuario (panel "Terminal" de la web) y el modelo (tool `terminal`).
 *
 * Cada comando se manda codificado en base64 y se ejecuta con dot-source, así un comando a medias
 * (comillas sin cerrar…) no se "come" las líneas siguientes y los `cd`/variables se conservan.
 * Tras cada comando se imprime una marca con un código aleatorio para saber cuándo terminó,
 * con qué código de salida y en qué carpeta quedó.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export type TermChunk = { text: string; err: boolean };
export type TermBlock = {
	id: number;
	/** Quién lo ejecutó: el usuario, Shiro, o avisos de la propia terminal. */
	by: "user" | "shiro" | "system";
	command: string;
	cwd: string;
	chunks: TermChunk[];
	running: boolean;
	exitCode?: number | null;
	truncated?: boolean;
};
export type TermEvent =
	| { type: "snapshot"; blocks: TermBlock[]; cwd: string; shell: string }
	| { type: "block"; block: TermBlock }
	| { type: "out"; id: number; text: string; err: boolean }
	| { type: "end"; id: number; exitCode: number | null; cwd: string };

type ShellKind = "pwsh" | "powershell" | "bash" | "sh";
type Shell = { kind: ShellKind; file: string; args: string[] };

const MAX_BLOCKS = 150;
const MAX_BLOCK_CHARS = 100_000;
export const MAX_COMMAND_CHARS = 8000;

/** Quita los códigos de color/cursor de la terminal (ANSI). */
export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/** Saltos de línea de Windows a "\n"; los "\r" sueltos (barras de progreso) se quitan. */
function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function findShell(): Shell {
	if (process.platform === "win32") {
		// PowerShell 7 si está instalado (mejor UTF-8 y errores más claros); si no, la 5.1 de Windows.
		const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "1"], { windowsHide: true, timeout: 10_000 });
		const kind: ShellKind = probe.status === 0 ? "pwsh" : "powershell";
		return { kind, file: kind === "pwsh" ? "pwsh" : "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"] };
	}
	const file = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
	return { kind: file.endsWith("bash") ? "bash" : "sh", file, args: ["-s"] };
}

/** Entorno para la terminal sin las claves de Shiro (API keys, tokens): el modelo puede leer la terminal. */
export function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) || k.startsWith("SHIRO_")) continue;
		env[k] = v;
	}
	env.NO_COLOR = "1";
	return env;
}

function isPowerShell(kind: ShellKind): boolean {
	return kind === "pwsh" || kind === "powershell";
}

/** Texto que se escribe en la terminal para ejecutar un comando y marcar su final. */
export function wrapCommand(kind: ShellKind, command: string, mark: string): string {
	const b64 = Buffer.from(command, "utf8").toString("base64");
	if (isPowerShell(kind)) {
		// Código de salida: el del programa si falló; 1 si hubo errores de PowerShell; si no, 0.
		return [
			`$LASTEXITCODE = 0; $Error.Clear(); . ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))`,
			`$__shiroOk = $?; $__shiroCode = if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $__shiroOk -or $Error.Count) { 1 } else { 0 }; [Console]::Out.WriteLine(); [Console]::Out.WriteLine('${mark}' + $__shiroCode + '|' + (Get-Location).ProviderPath)`,
			"",
		].join("\n");
	}
	return [`eval "$(printf '%s' '${b64}' | base64 --decode)"`, `__shiro_ok=$?; printf '\\n${mark}%s|%s\\n' "$__shiro_ok" "$PWD"`, ""].join("\n");
}

function promptFor(kind: ShellKind | undefined, cwd: string): string {
	return !kind || isPowerShell(kind) ? `PS ${cwd}>` : `${cwd}$`;
}

class TerminalSession {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private shell: Shell | null = null;
	private readonly mark = `__SHIRO_END_${randomBytes(6).toString("hex")}__|`;
	/** Salida pendiente de revisar (puede contener media marca). */
	private buf = "";
	/** Comandos enviados que aún no terminaron; el primero es el que se está ejecutando. */
	private queue: TermBlock[] = [];
	private blocks: TermBlock[] = [];
	private seq = 0;
	private listeners = new Set<(e: TermEvent) => void>();
	private waiters = new Map<number, () => void>();
	/** Cómo detener lo que se muestra con external() (Claude Code), por bloque. */
	private externalStops = new Map<number, () => void>();
	cwd = homedir();

	constructor() {
		process.on("exit", () => this.proc?.kill());
	}

	get shellName(): string {
		return this.shell ? (this.shell.kind === "pwsh" ? "PowerShell 7" : this.shell.kind === "powershell" ? "Windows PowerShell" : this.shell.kind) : process.platform === "win32" ? "PowerShell" : "bash";
	}

	get prompt(): string {
		return promptFor(this.shell?.kind, this.cwd);
	}

	subscribe(fn: (e: TermEvent) => void): () => void {
		this.listeners.add(fn);
		fn(this.snapshotEvent());
		return () => this.listeners.delete(fn);
	}

	private snapshotEvent(): TermEvent {
		return { type: "snapshot", blocks: this.blocks.map((b) => ({ ...b, chunks: [...b.chunks] })), cwd: this.cwd, shell: this.shellName };
	}

	private emit(e: TermEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(e);
			} catch {
				/* un panel roto no afecta a los demás */
			}
		}
	}

	private start(): ChildProcessWithoutNullStreams {
		const shell = (this.shell ??= findShell());
		const cwd = existsSync(this.cwd) ? this.cwd : homedir();
		const proc = spawn(shell.file, shell.args, { cwd, env: cleanEnv(), windowsHide: true, stdio: "pipe" });
		proc.stdout.setEncoding("utf8");
		proc.stderr.setEncoding("utf8");
		proc.stdout.on("data", (d: string) => this.proc === proc && this.onStdout(d));
		proc.stderr.on("data", (d: string) => this.proc === proc && this.onOutput(d, true));
		const ended = (why: string) => {
			if (this.proc !== proc) return;
			this.proc = null;
			this.flushPending();
			for (const b of this.queue.splice(0)) this.finish(b, null);
			this.info(why);
		};
		proc.on("exit", () => ended("La terminal se cerró. Se abrirá otra con el siguiente comando."));
		proc.on("error", (err) => ended(`No se pudo abrir la terminal: ${err.message}`));
		proc.stdin.on("error", () => {});
		this.proc = proc;
		if (isPowerShell(shell.kind)) {
			proc.stdin.write(
				"$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Text.UTF8Encoding]::new($false); if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\n",
			);
		} else {
			proc.stdin.write("export TERM=dumb\n");
		}
		return proc;
	}

	private onStdout(data: string): void {
		this.buf += data;
		for (;;) {
			const i = this.buf.indexOf(this.mark);
			if (i < 0) break;
			const nl = this.buf.indexOf("\n", i);
			if (nl < 0) break; // la marca aún no llegó entera
			// Se quita el salto de línea que se imprime justo antes de la marca.
			const before = this.buf.slice(0, i).replace(/\r?\n$/, "");
			if (before) this.onOutput(before, false);
			const [code, ...cwd] = this.buf.slice(i + this.mark.length, nl).replace(/\r$/, "").split("|");
			this.buf = this.buf.slice(nl + 1);
			const block = this.queue.shift();
			if (cwd.join("|").trim()) this.cwd = cwd.join("|").trim();
			if (block) this.finish(block, Number.isFinite(Number(code)) && code !== "" ? Number(code) : null);
		}
		// Se guarda solo lo que podría ser el principio de una marca (o el salto previo a ella).
		let keep = 0;
		const pending = this.buf.indexOf(this.mark);
		if (pending >= 0) keep = this.buf.length - pending;
		else {
			for (let k = Math.min(this.mark.length - 1, this.buf.length); k > 0; k--) {
				if (this.mark.startsWith(this.buf.slice(-k))) {
					keep = k;
					break;
				}
			}
		}
		const rest = this.buf.slice(0, this.buf.length - keep);
		const nlTail = /\r?\n$/.exec(rest)?.[0].length ?? 0;
		keep += nlTail;
		const out = this.buf.slice(0, this.buf.length - keep);
		this.buf = this.buf.slice(this.buf.length - keep);
		if (out) this.onOutput(out, false);
	}

	private flushPending(): void {
		const rest = this.buf;
		this.buf = "";
		if (rest) this.onOutput(rest, false);
	}

	private onOutput(raw: string, err: boolean): void {
		const text = normalizeNewlines(stripAnsi(raw));
		if (!text) return;
		let block = this.queue[0] ?? this.blocks[this.blocks.length - 1];
		if (!block) block = this.addBlock("system", "", false);
		const last = block.chunks[block.chunks.length - 1];
		if (last && last.err === err) last.text += text;
		else block.chunks.push({ text, err });
		this.trimBlock(block);
		this.emit({ type: "out", id: block.id, text, err });
	}

	private trimBlock(block: TermBlock): void {
		let size = block.chunks.reduce((n, c) => n + c.text.length, 0);
		while (size > MAX_BLOCK_CHARS && block.chunks.length) {
			const first = block.chunks[0];
			const drop = Math.min(first.text.length, size - MAX_BLOCK_CHARS);
			first.text = first.text.slice(drop);
			size -= drop;
			block.truncated = true;
			if (!first.text) block.chunks.shift();
		}
	}

	private addBlock(by: TermBlock["by"], command: string, running: boolean, cwd = this.cwd): TermBlock {
		const block: TermBlock = { id: ++this.seq, by, command, cwd, chunks: [], running };
		this.blocks.push(block);
		while (this.blocks.length > MAX_BLOCKS) {
			const idx = this.blocks.findIndex((b) => !b.running);
			if (idx < 0) break;
			this.blocks.splice(idx, 1);
		}
		this.emit({ type: "block", block: { ...block, chunks: [] } });
		return block;
	}

	private info(text: string): void {
		const block = this.addBlock("system", "", false);
		block.chunks.push({ text, err: false });
		this.emit({ type: "out", id: block.id, text, err: false });
	}

	private finish(block: TermBlock, exitCode: number | null): void {
		block.running = false;
		block.exitCode = exitCode;
		this.emit({ type: "end", id: block.id, exitCode, cwd: this.cwd });
		this.waiters.get(block.id)?.();
		this.waiters.delete(block.id);
	}

	/**
	 * Un bloque para mostrar lo que hace otro programa (Claude Code) sin pasar por la PowerShell:
	 * se escribe con write() y se cierra con end().
	 */
	external(title: string, cwd: string, onStop?: () => void): { write: (text: string, err?: boolean) => void; end: (exitCode: number | null) => void } {
		const block = this.addBlock("shiro", title, true, cwd);
		if (onStop) this.externalStops.set(block.id, onStop);
		return {
			write: (raw, err = false) => {
				const text = normalizeNewlines(stripAnsi(raw));
				if (!text || !block.running) return;
				const last = block.chunks[block.chunks.length - 1];
				if (last && last.err === err) last.text += text;
				else block.chunks.push({ text, err });
				this.trimBlock(block);
				this.emit({ type: "out", id: block.id, text, err });
			},
			end: (exitCode) => {
				this.externalStops.delete(block.id);
				if (!block.running) return;
				block.running = false;
				block.exitCode = exitCode;
				this.emit({ type: "end", id: block.id, exitCode, cwd: this.cwd });
			},
		};
	}

	/** Ejecuta un comando a la vista (se encola si hay otro en marcha). */
	run(command: string, by: "user" | "shiro"): TermBlock {
		const cmd = command.replace(/\r\n?/g, "\n").trim();
		if (!cmd) throw new Error("Escribe un comando.");
		if (cmd.length > MAX_COMMAND_CHARS) throw new Error("El comando es demasiado largo.");
		const proc = this.proc ?? this.start();
		const block = this.addBlock(by, cmd, true);
		this.queue.push(block);
		proc.stdin.write(wrapCommand(this.shell!.kind, cmd, this.mark));
		return block;
	}

	/** Ejecuta y espera a que termine (o a que pase el tiempo). */
	async runAndWait(command: string, by: "user" | "shiro", timeoutMs: number): Promise<{ block: TermBlock; finished: boolean }> {
		const block = this.run(command, by);
		if (!block.running) return { block, finished: true };
		const finished = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.waiters.delete(block.id);
				resolve(false);
			}, timeoutMs);
			this.waiters.set(block.id, () => {
				clearTimeout(timer);
				resolve(true);
			});
		});
		return { block, finished };
	}

	isRunning(): boolean {
		return this.queue.length > 0;
	}

	/** Detiene lo que se esté ejecutando: cierra la terminal (la carpeta actual se conserva). */
	stop(): boolean {
		// Lo que se muestra con external() (Claude Code) también se detiene.
		const externals = [...this.externalStops.values()];
		this.externalStops.clear();
		for (const fn of externals) fn();
		const proc = this.proc;
		// Si solo se paraba Claude Code, la PowerShell sigue como estaba.
		if (!proc || (externals.length && !this.queue.length)) return externals.length > 0;
		const busy = this.queue.length > 0;
		this.proc = null;
		this.flushPending();
		for (const b of this.queue.splice(0)) {
			b.chunks.push({ text: "\n^C", err: true });
			this.emit({ type: "out", id: b.id, text: "\n^C", err: true });
			this.finish(b, null);
		}
		if (process.platform === "win32" && proc.pid) {
			spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
		} else {
			proc.kill("SIGKILL");
		}
		this.info(busy ? "Comando detenido. La terminal se reinició (sigues en la misma carpeta)." : "La terminal se reinició.");
		return busy;
	}

	/** Borra lo mostrado (menos lo que se está ejecutando). */
	clear(): void {
		this.blocks = this.blocks.filter((b) => b.running);
		this.emit(this.snapshotEvent());
	}

	/** Texto de la salida de un bloque. */
	static outputOf(block: TermBlock): string {
		return (block.truncated ? "…" : "") + block.chunks.map((c) => c.text).join("");
	}

	/** Lo último que hay en la terminal, como texto (para el modelo). */
	readText(maxLines = 80, maxChars = 6000): string {
		const kind = this.shell?.kind;
		const lines: string[] = [];
		for (const b of this.blocks) {
			if (b.by !== "system") lines.push(`${promptFor(kind, b.cwd)} ${b.command}${b.by === "shiro" ? "   (lo ejecutó Shiro)" : ""}`);
			const out = TerminalSession.outputOf(b).replace(/\n+$/, "");
			if (out) lines.push(...out.split("\n"));
			if (b.running) lines.push("[sigue ejecutándose…]");
			else if (b.by !== "system" && b.exitCode !== undefined && b.exitCode !== 0) {
				lines.push(b.exitCode === null ? "[interrumpido]" : `[terminó con código ${b.exitCode}]`);
			}
		}
		if (!lines.length) return `La terminal está vacía: todavía no se ha ejecutado nada. Carpeta actual: ${this.cwd}`;
		let text = lines.slice(-maxLines).join("\n");
		if (text.length > maxChars) text = "…" + text.slice(-maxChars);
		return `Terminal (${this.shellName}), carpeta actual: ${this.cwd}\n\n${text}`;
	}
}

export { TerminalSession };
export const terminal = new TerminalSession();
