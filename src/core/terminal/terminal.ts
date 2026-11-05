/**
 * Terminal de Shiro: una consola de verdad (PTY) que queda abierta, compartida por el usuario (panel
 * "Terminal" de la web) y el modelo (tool `terminal`). Los programas creen que están en una terminal
 * normal: pueden pedir contraseñas y dibujar su pantalla (Claude Code, ssh, sudo, vim…).
 *
 * - node-pty abre la shell. Una copia de xterm sin ventana (`screen`) interpreta lo que sale: de ahí
 *   sale el texto que lee el modelo y lo que recibe un panel al conectarse.
 * - El prompt imprime una marca invisible (OSC 777) con un código aleatorio: así se sabe cuándo empieza
 *   y acaba un comando (también los que escribe el usuario), con qué código y en qué carpeta quedó.
 * - Las contraseñas: los programas apagan el eco, así que lo que el usuario escribe en el panel no llega
 *   a la pantalla ni al modelo. Si un comando del modelo pide una, `settle` avisa al panel y espera.
 */
import type { IPty } from "@lydell/node-pty";
import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { homedir, release } from "node:os";
import { delimiter, join } from "node:path";
import { loadPty } from "./ptyLoader.js";

const { Terminal: ScreenTerminal } = headless;

/** Bloque aparte para lo que hace otro programa sin pasar por la consola (la tool claude_code). */
export type TermChunk = { text: string; err: boolean };
export type TermBlock = {
	id: number;
	command: string;
	cwd: string;
	chunks: TermChunk[];
	running: boolean;
	exitCode?: number | null;
	truncated?: boolean;
};
/** Algo que el usuario tiene que hacer en el panel. */
export type TermAttention = { kind: "password"; prompt: string };
export type TermEvent =
	| { type: "snapshot"; data: string; cols: number; rows: number; cwd: string; shell: string; busy: boolean; attention: TermAttention | null; blocks: TermBlock[]; windowsBuild: number | null }
	| { type: "data"; data: string }
	| { type: "state"; busy: boolean; cwd: string; shell: string }
	| { type: "attention"; attention: TermAttention | null }
	| { type: "notice"; text: string }
	| { type: "clear" }
	| { type: "block"; block: TermBlock }
	| { type: "out"; id: number; text: string; err: boolean }
	| { type: "end"; id: number; exitCode: number | null; cwd: string };

/** Cómo terminó la espera: acabó, parece esperar que le escriban, pide contraseña, se acabó el tiempo o se canceló. */
export type TermOutcome = "finished" | "input" | "password" | "timeout" | "aborted";
export type TermRunResult = { outcome: TermOutcome; exitCode: number | null; cwd: string; output: string };

type ShellKind = "pwsh" | "powershell" | "bash" | "sh";
type Shell = { kind: ShellKind; file: string; args: string[]; env?: Record<string, string> };

const MAX_BLOCKS = 20;
const MAX_BLOCK_CHARS = 100_000;
export const MAX_COMMAND_CHARS = 8000;
export const MAX_INPUT_CHARS = 64_000;
const SCROLLBACK = 5000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const POLL_MS = 80;
const READY_TIMEOUT_MS = 20_000;
/** Tiempo que el usuario tiene para escribir una contraseña en el panel. */
const PASSWORD_WAIT_MS = 3 * 60_000;
/** Lo que tarda `stop` en cerrarlo todo si Ctrl+C no bastó. */
const STOP_GRACE_MS = 2000;
const OSC_MARK = 777;

/** Quita los códigos de color/cursor de la terminal (ANSI). */
export function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");
}

/** Saltos de línea de Windows a "\n"; los "\r" sueltos (barras de progreso) se quitan. */
function normalizeNewlines(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

const PASSWORD_PROMPT = /(pass\s?word|passwd|passphrase|passcode|contrase[ñn]a|\bclave\b|\bpin\b|\botp\b|\b2fa\b|one[- ]time|c[oó]digo de verificaci[oó]n|verification code)[^\n]{0,80}[:：?>]\s*$/i;

/** ¿Esta línea (la del cursor) parece pedir una contraseña? */
export function looksLikePasswordPrompt(line: string): boolean {
	return PASSWORD_PROMPT.test(line.trimEnd());
}

const KEY_CODES: Record<string, string> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	esc: "\x1b",
	escape: "\x1b",
	backspace: "\x7f",
	delete: "\x1b[3~",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};

/** "ctrl+c", "down down enter" → lo que manda el teclado a la terminal. Lanza un error si no conoce una tecla. */
export function parseKeys(keys: string): string {
	let out = "";
	for (const key of keys.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
		const ctrl = /^ctrl\+([a-z])$/.exec(key);
		if (ctrl) out += String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
		else if (key in KEY_CODES) out += KEY_CODES[key];
		else if (key.length === 1) out += key;
		else throw new Error(`No conozco la tecla «${key}». Usa: ${Object.keys(KEY_CODES).join(", ")}, ctrl+<letra> o una letra suelta.`);
	}
	return out;
}

function powershellInit(token: string): string {
	const mark = (body: string) => `[char]27 + "]${OSC_MARK};shiro;${token};${body}" + [char]7`;
	return `
$OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = $OutputEncoding
function global:prompt {
	$ok = $global:?
	$code = if ($global:LASTEXITCODE) { $global:LASTEXITCODE } elseif (-not $ok) { 1 } else { 0 }
	$global:LASTEXITCODE = 0
	$cwd = (Get-Location).ProviderPath
	${mark("D;$code;$cwd")} + "PS $cwd> "
}
if (-not (Get-Module PSReadLine)) { Import-Module PSReadLine -ErrorAction SilentlyContinue }
if (Get-Module PSReadLine) {
	Set-PSReadLineOption -HistorySaveStyle SaveNothing -BellStyle None
	try { Set-PSReadLineOption -PredictionSource None } catch {}
	Set-PSReadLineKeyHandler -Chord Ctrl+u -Function RevertLine
	$global:__shiroReadLine = $function:PSConsoleHostReadLine
	function global:PSConsoleHostReadLine {
		$line = $global:__shiroReadLine.Invoke()
		[Console]::Write(${mark("C")})
		$line
	}
}
`;
}

/**
 * ¿Está este programa en el PATH? Sin lanzarlo: abrir la terminal no debe parar el servidor. Con lstat,
 * porque el pwsh de la Microsoft Store es un alias que stat no sabe abrir.
 */
function onPath(file: string): boolean {
	for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
		try {
			if (dir && lstatSync(join(dir, file))) return true;
		} catch {
			/* no está en esta carpeta */
		}
	}
	return false;
}

function powershell(kind: "pwsh" | "powershell", token: string): Shell {
	const init = Buffer.from(powershellInit(token), "utf16le").toString("base64");
	// node-pty necesita el nombre con su extensión.
	return { kind, file: kind === "pwsh" ? "pwsh.exe" : "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", init] };
}

function findShell(token: string): Shell {
	// PowerShell 7 si está instalado (mejor UTF-8 y errores más claros); si no, la 5.1 de Windows.
	if (process.platform === "win32") return powershell(onPath("pwsh.exe") ? "pwsh" : "powershell", token);
	if (!existsSync("/bin/bash")) return { kind: "sh", file: "/bin/sh", args: ["-i"] };
	return {
		kind: "bash",
		file: "/bin/bash",
		args: ["--noprofile", "--norc", "-i"],
		env: {
			PS1: "\\u@\\h:\\w\\$ ",
			PS0: `\\e]${OSC_MARK};shiro;${token};C\\a`,
			PROMPT_COMMAND: `printf '\\033]${OSC_MARK};shiro;${token};D;%s;%s\\007' "$?" "$PWD"`,
			HISTFILE: "/dev/null",
		},
	};
}

/** Entorno para la terminal sin las claves de Shiro (API keys, tokens): el modelo puede leer la terminal. */
export function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) {
		// CLAUDECODE: si Shiro se abrió desde Claude Code, `claude` se negaría a arrancar creyéndose dentro de sí mismo.
		if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i.test(k) || k.startsWith("SHIRO_") || /^CLAUDE_?CODE/i.test(k)) continue;
		env[k] = v;
	}
	env.NO_COLOR = "1";
	return env;
}

/** El de cleanEnv, pero esta sí es una terminal con colores. */
function ptyEnv(shell: Shell): NodeJS.ProcessEnv {
	const env = cleanEnv();
	delete env.NO_COLOR;
	return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Shiro", ...shell.env };
}

function isPowerShell(kind: ShellKind): boolean {
	return kind === "pwsh" || kind === "powershell";
}

/** Un comando de varias líneas se manda en una sola: si no, cada salto de línea se tomaría como Enter. */
export function wrapCommand(kind: ShellKind, command: string): string {
	const b64 = Buffer.from(command, "utf8").toString("base64");
	if (isPowerShell(kind)) return `. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))))`;
	return `eval "$(printf '%s' '${b64}' | base64 --decode)"`;
}

/** El número de compilación de Windows (la terminal lo usa para saber cómo se reacomodan las líneas). */
function windowsBuild(): number | null {
	if (process.platform !== "win32") return null;
	const build = Number(release().split(".")[2]);
	return Number.isFinite(build) ? build : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class TerminalSession {
	private pty: IPty | null = null;
	private shell: Shell | null = null;
	private readonly token = randomBytes(6).toString("hex");
	private readonly screen = new ScreenTerminal({
		cols: DEFAULT_COLS,
		rows: DEFAULT_ROWS,
		scrollback: SCROLLBACK,
		allowProposedApi: true,
		// Al borrar la pantalla (cls, o una consola nueva) lo anterior sigue arriba.
		scrollOnEraseInDisplay: true,
		...(windowsBuild() ? { windowsPty: { backend: "conpty" as const, buildNumber: windowsBuild()! } } : {}),
	});
	private readonly serializer = new SerializeAddon();
	private listeners = new Set<(e: TermEvent) => void>();
	private pendingOut = "";
	private outTimer: ReturnType<typeof setTimeout> | null = null;
	/** Hay un programa o comando en marcha (entre la marca de inicio y la del prompt). */
	private busy = false;
	/** La shell ya mostró su primer prompt. */
	private ready = false;
	private lastExit: number | null = null;
	private lastOutputAt = 0;
	/** Cuándo se pulsó Enter por última vez: tras una contraseña, el programa aún no ha contestado. */
	private answeredAt = 0;
	private attention: TermAttention | null = null;
	/** Bloques de external(): se muestran aparte de la consola. */
	private blocks: TermBlock[] = [];
	private seq = 0;
	/** Cómo detener lo que se muestra con external() (Claude Code), por bloque. */
	private externalStops = new Map<number, () => void>();
	cwd = homedir();

	constructor() {
		this.screen.loadAddon(this.serializer);
		this.screen.parser.registerOscHandler(OSC_MARK, (data) => this.onMark(data));
		process.on("exit", () => this.pty && this.killProcess(this.pty));
	}

	get shellName(): string {
		const kind = this.shell?.kind;
		return kind ? (kind === "pwsh" ? "PowerShell 7" : kind === "powershell" ? "Windows PowerShell" : kind) : process.platform === "win32" ? "PowerShell" : "bash";
	}

	subscribe(fn: (e: TermEvent) => void): () => void {
		// Lo que se emite ya pasó por `screen`: la foto de ahora más lo que venga después no pierde nada.
		this.flushOut();
		this.listeners.add(fn);
		fn({
			type: "snapshot",
			data: this.serializer.serialize({ scrollback: SCROLLBACK }),
			cols: this.screen.cols,
			rows: this.screen.rows,
			cwd: this.cwd,
			shell: this.shellName,
			busy: this.busy,
			attention: this.attention,
			blocks: this.blocks.map((b) => ({ ...b, chunks: [...b.chunks] })),
			windowsBuild: windowsBuild(),
		});
		return () => this.listeners.delete(fn);
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

	private flushOut(): void {
		if (this.outTimer) clearTimeout(this.outTimer);
		this.outTimer = null;
		const data = this.pendingOut;
		this.pendingOut = "";
		if (data) this.emit({ type: "data", data });
	}

	/** Pone salida en `screen` y, ya interpretada, la manda a los paneles (varias juntas, cada pocos ms). */
	private feed(data: string): void {
		this.screen.write(data, () => {
			this.pendingOut += data;
			this.outTimer ??= setTimeout(() => this.flushOut(), 12);
		});
	}

	/** Espera a que `screen` haya interpretado todo lo recibido. */
	private flushScreen(): Promise<void> {
		return new Promise((resolve) => this.screen.write("", resolve));
	}

	private onMark(data: string): boolean {
		const [ns, token, kind, code, ...cwd] = data.split(";");
		if (ns !== "shiro" || token !== this.token) return true;
		if (kind === "C") {
			this.setBusy(true);
		} else if (kind === "D") {
			this.ready = true;
			this.lastExit = Number.isFinite(Number(code)) ? Number(code) : null;
			if (cwd.join(";").trim()) this.cwd = cwd.join(";").trim();
			this.setAttention(null);
			this.setBusy(false);
		}
		return true;
	}

	private setBusy(busy: boolean): void {
		const changed = this.busy !== busy;
		this.busy = busy;
		if (changed || !busy) this.emit({ type: "state", busy, cwd: this.cwd, shell: this.shellName });
	}

	private setAttention(attention: TermAttention | null): void {
		if (this.attention === attention) return;
		this.attention = attention;
		this.emit({ type: "attention", attention });
	}

	/** Abre la shell si no hay una (la primera vez, o si se cerró). */
	ensureStarted(): IPty {
		if (this.pty) return this.pty;
		const open = (shell: Shell) =>
			loadPty().spawn(shell.file, shell.args, {
				name: "xterm-256color",
				cols: this.screen.cols,
				rows: this.screen.rows,
				cwd: existsSync(this.cwd) ? this.cwd : homedir(),
				env: ptyEnv(shell),
				// El conhost que trae la librería: no depende de la versión de Windows y se cierra sin procesos de más.
				useConptyDll: process.platform === "win32",
			});
		let proc: IPty;
		this.shell ??= findShell(this.token);
		try {
			proc = open(this.shell);
		} catch (err) {
			// Un PowerShell 7 que está en el PATH pero no abre: queda la de Windows.
			if (this.shell.kind !== "pwsh") throw err;
			this.shell = powershell("powershell", this.token);
			proc = open(this.shell);
		}
		this.pty = proc;
		this.ready = false;
		this.busy = false;
		proc.onData((data) => {
			if (this.pty !== proc) return;
			this.lastOutputAt = Date.now();
			this.feed(data);
		});
		proc.onExit(() => {
			if (this.pty !== proc) return;
			this.pty = null;
			this.ready = false;
			this.setAttention(null);
			this.setBusy(false);
			this.feed("\r\n\x1b[2m[La terminal se cerró. Pulsa una tecla para abrir otra.]\x1b[0m\r\n");
		});
		this.emit({ type: "state", busy: false, cwd: this.cwd, shell: this.shellName });
		return proc;
	}

	/** Cierra la consola y todo lo que tenga abierto. */
	private killProcess(proc: IPty): void {
		try {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true });
				proc.kill();
			} else {
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					/* ya no existía el grupo */
				}
				proc.kill("SIGKILL");
			}
		} catch {
			/* ya estaba cerrada */
		}
	}

	/** Espera el primer prompt de la shell. */
	private async whenReady(): Promise<IPty> {
		const proc = this.ensureStarted();
		// `sh` no tiene marcas: se le da un momento.
		if (this.shell?.kind === "sh") {
			await sleep(300);
			return proc;
		}
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (!this.ready) {
			if (this.pty !== proc) throw new Error("La terminal se cerró al abrirse.");
			if (Date.now() > deadline) throw new Error("La terminal tarda demasiado en abrirse.");
			await sleep(POLL_MS);
		}
		return proc;
	}

	/** La línea donde está el cursor. */
	private cursorLine(): string {
		const b = this.screen.buffer.active;
		return b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? "";
	}

	/** ¿Un programa está pidiendo una contraseña ahora mismo? */
	waitingForPassword(): boolean {
		return this.busy && looksLikePasswordPrompt(this.cursorLine());
	}

	/** Las líneas de la terminal como texto: las que el ancho partió en varias se vuelven a unir. */
	private bufferLines(from = 0, to?: number): string[] {
		const b = this.screen.buffer.active;
		const end = Math.min(to ?? b.length, b.length);
		const out: string[] = [];
		for (let i = Math.max(0, from); i < end; i++) {
			const line = b.getLine(i);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && out.length) out[out.length - 1] += text;
			else out.push(text);
		}
		while (out.length && !out[out.length - 1].trim()) out.pop();
		return out;
	}

	/**
	 * Espera a que pase algo que el modelo deba saber. `quietMs`: tras cuánto silencio se devuelve el
	 * control; sin él (run) solo si, además, el cursor quedó tras un texto o el programa ocupa la pantalla
	 * entera: un comando largo y callado no debe parecer una pregunta.
	 */
	private async settle(timeoutMs: number, signal: AbortSignal | undefined, quietMs?: number): Promise<TermOutcome> {
		const started = Date.now();
		let deadline = started + timeoutMs;
		for (;;) {
			await sleep(POLL_MS);
			if (signal?.aborted) {
				this.setAttention(null);
				return "aborted";
			}
			if (!this.pty) return "finished";
			const now = Date.now();
			const quiet = now - Math.max(this.lastOutputAt, started);
			if (!this.busy) {
				if (quietMs === undefined || quiet >= Math.min(quietMs, 300)) {
					if (this.shell?.kind !== "sh" || quiet >= 1500) return "finished";
				}
			} else {
				if (quiet >= 600 && this.waitingForPassword() && this.answeredAt <= this.lastOutputAt) {
					// Sin panel abierto nadie puede escribirla.
					if (!this.listeners.size) return "password";
					if (!this.attention) {
						this.setAttention({ kind: "password", prompt: this.cursorLine().trim() });
						deadline = Math.max(deadline, now + PASSWORD_WAIT_MS);
					}
					if (now >= deadline) {
						this.setAttention(null);
						return "password";
					}
					continue;
				}
				const b = this.screen.buffer.active;
				if (quietMs !== undefined ? quiet >= quietMs : quiet >= 2500 && (b.cursorX > 0 || b.type === "alternate")) return "input";
			}
			if (now >= deadline) return "timeout";
		}
	}

	/** Ejecuta un comando a la vista y espera a que termine o a que el programa espere algo. */
	async runAndWait(command: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<TermRunResult> {
		const cmd = command.replace(/\r\n?/g, "\n").trim();
		if (!cmd) throw new Error("Escribe un comando.");
		if (cmd.length > MAX_COMMAND_CHARS) throw new Error("El comando es demasiado largo.");
		const proc = await this.whenReady();
		if (this.busy) {
			throw new Error(`Hay un programa abierto en la terminal: no escribo otro comando encima. Usa action=write para responderle, action=read para mirar o action=stop para cerrarlo.\n\n${this.tail()}`);
		}
		await this.flushScreen();
		// El marcador sigue a la línea aunque las más viejas se pierdan por arriba.
		const marker = this.screen.registerMarker(0);
		this.setBusy(true);
		// Ctrl+U borra lo que el usuario estuviera escribiendo, para no mezclarlo con el comando.
		proc.write(`\x15${cmd.includes("\n") ? wrapCommand(this.shell!.kind, cmd) : cmd}\r`);
		const outcome = await this.settle(opts.timeoutMs, opts.signal);
		await this.flushScreen();
		const b = this.screen.buffer.active;
		const start = marker && marker.line >= 0 ? marker.line : 0;
		// La primera línea es el prompt con el comando; al terminar, la del cursor es el prompt nuevo.
		const lines = this.bufferLines(start, outcome === "finished" ? b.baseY + b.cursorY : undefined).slice(1);
		marker?.dispose();
		return { outcome, exitCode: outcome === "finished" ? this.lastExit : null, cwd: this.cwd, output: lines.join("\n") };
	}

	/** Teclea texto y/o teclas en lo que esté abierto, y espera a que la pantalla se calme. */
	async write(opts: { text?: string; enter?: boolean; keys?: string; timeoutMs: number; signal?: AbortSignal }): Promise<TermOutcome> {
		const keys = parseKeys(opts.keys ?? "");
		const text = (opts.text ?? "").replace(/\r\n?/g, "\n");
		if (!text && !keys && !opts.enter) throw new Error("Indica el texto (text) o las teclas (keys).");
		if (text.length > MAX_INPUT_CHARS) throw new Error("El texto es demasiado largo.");
		const proc = await this.whenReady();
		if (text) proc.write(text);
		if (opts.enter) {
			// Enter aparte: algunos programas toman todo lo que llega junto por texto pegado y no lo envían.
			if (text) await sleep(120);
			this.markAnswered();
			proc.write("\r");
		}
		if (keys) proc.write(keys);
		return this.settle(opts.timeoutMs, opts.signal, 1000);
	}

	/** Espera a que lo que esté en marcha termine o se quede callado (para `read` con espera). */
	watch(timeoutMs: number, signal?: AbortSignal): Promise<TermOutcome> {
		return this.settle(timeoutMs, signal, 3000);
	}

	private markAnswered(): void {
		this.answeredAt = Date.now();
		this.setAttention(null);
	}

	/** Lo que el usuario teclea en el panel. */
	input(data: string): void {
		if (!data) return;
		const proc = this.ensureStarted();
		if (/[\r\n]/.test(data)) this.markAnswered();
		proc.write(data.slice(0, MAX_INPUT_CHARS));
	}

	/** El panel cambió de tamaño. */
	resize(cols: number, rows: number): void {
		const c = Math.max(20, Math.min(400, Math.trunc(cols)));
		const r = Math.max(5, Math.min(200, Math.trunc(rows)));
		if (c === this.screen.cols && r === this.screen.rows) return;
		this.screen.resize(c, r);
		try {
			this.pty?.resize(c, r);
		} catch {
			/* la consola se estaba cerrando */
		}
	}

	isRunning(): boolean {
		return this.busy;
	}

	/**
	 * Un bloque para mostrar lo que hace otro programa (Claude Code) sin pasar por la consola:
	 * se escribe con write() y se cierra con end().
	 */
	external(title: string, cwd: string, onStop?: () => void): { write: (text: string, err?: boolean) => void; end: (exitCode: number | null) => void } {
		const block: TermBlock = { id: ++this.seq, command: title, cwd, chunks: [], running: true };
		this.blocks.push(block);
		while (this.blocks.length > MAX_BLOCKS) {
			const idx = this.blocks.findIndex((b) => !b.running);
			if (idx < 0) break;
			this.blocks.splice(idx, 1);
		}
		this.emit({ type: "block", block: { ...block, chunks: [] } });
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

	/**
	 * Detiene lo que esté en marcha: Ctrl+C y, si en 2 s no volvió al prompt, cierra la consola y abre
	 * otra en la misma carpeta. Devuelve true si había algo en marcha.
	 */
	stop(): boolean {
		// Lo que se muestra con external() (Claude Code) también se detiene.
		const externals = [...this.externalStops.values()];
		this.externalStops.clear();
		for (const fn of externals) fn();
		const proc = this.pty;
		if (!proc || !this.busy) return externals.length > 0;
		proc.write("\x03");
		setTimeout(() => {
			if (this.pty === proc && this.busy) this.restart();
		}, STOP_GRACE_MS);
		return true;
	}

	/** Espera a que vuelva el prompt (true) o a que pase el tiempo (false). Para `stop`. */
	async whenIdle(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.busy && Date.now() < deadline) await sleep(POLL_MS);
		return !this.busy;
	}

	private restart(): void {
		const proc = this.pty;
		this.pty = null;
		this.setAttention(null);
		this.setBusy(false);
		if (proc) this.killProcess(proc);
		this.emit({ type: "notice", text: "Lo que estaba abierto no respondía: reinicié la terminal (sigues en la misma carpeta)." });
		this.ensureStarted();
	}

	/** Cierra la consola sin abrir otra. */
	dispose(): void {
		const proc = this.pty;
		this.pty = null;
		this.ready = false;
		this.busy = false;
		if (proc) this.killProcess(proc);
	}

	/** Borra lo mostrado (menos los bloques en marcha). */
	clear(): void {
		this.blocks = this.blocks.filter((b) => b.running);
		this.flushOut();
		this.screen.clear();
		this.emit({ type: "clear" });
		const proc = this.pty;
		if (!proc) return;
		try {
			proc.clear();
		} catch {
			/* la consola se estaba cerrando */
		}
		// En el prompt, Ctrl+L lo vuelve a pintar arriba.
		if (!this.busy) proc.write("\x0c");
	}

	/** Lo último de la pantalla (lo más reciente es lo que importa). */
	tail(maxLines = 80, maxChars = 6000): string {
		const text = this.bufferLines().slice(-maxLines).join("\n");
		return text.length > maxChars ? "…" + text.slice(-maxChars) : text;
	}

	/** Lo último que hay en la terminal, como texto (para el modelo). */
	async readText(maxLines = 80, maxChars = 6000): Promise<string> {
		if (!this.pty) return `La terminal no está abierta todavía. Carpeta actual: ${this.cwd}`;
		await this.flushScreen();
		const state = this.waitingForPassword()
			? "Un programa está pidiendo una contraseña: que la escriba el usuario en el panel Terminal."
			: this.busy
				? "Hay un programa abierto o un comando en marcha."
				: "Está en el prompt, lista para otro comando.";
		const external = this.blocks.some((b) => b.running) ? "\nClaude Code está trabajando aparte en una tarea." : "";
		return `Terminal (${this.shellName}), carpeta actual: ${this.cwd}\n${state}${external}\n\n${this.tail(maxLines, maxChars) || "(pantalla vacía)"}`;
	}
}

export { TerminalSession };
export const terminal = new TerminalSession();
