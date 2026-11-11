/**
 * Lo que el modelo necesita saber del sitio donde trabaja: sistema, consola, programas instalados,
 * modo y permisos (`## Entorno`), y qué herramienta usar para cada cosa (`## Qué herramienta usar`).
 * Así no adivina (comandos de bash en PowerShell) ni le pregunta al usuario lo que ya se sabe.
 * Solo va donde se puede pedir permiso (web y terminal): nunca a quien escribe por WhatsApp o Telegram.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { arch, homedir, release, version } from "node:os";
import { delimiter, join } from "node:path";
import type { ChatMode, PermissionMode } from "./chatMode.js";

export type EnvironmentFacts = {
	/** "Windows 11 Pro (x64)", "Kali GNU/Linux Rolling (x64)"… */
	os: string;
	windows: boolean;
	/** Corre dentro de un contenedor: solo ve lo que hay dentro. */
	docker: boolean;
	home: string;
	shell?: { name: string; kind: string; cwd: string };
	programs: { found: string[]; missing: string[] };
};

export type EnvironmentView = {
	mode: ChatMode;
	permissions: PermissionMode;
	/** Las herramientas de esta respuesta. */
	tools: string[];
	/** Tamaño del contexto del modelo en tokens, si se sabe. */
	contextLimit?: number;
	/** «Permisos» de Ajustes: `allow` no pregunta nada y `deny` bloquea lo que tiene efectos. */
	approvalMode?: "ask" | "allow" | "deny";
};

const DEV_PROGRAMS = ["git", "node", "npm", "python", "docker", "rg", "gh"];
const HACKING_PROGRAMS = ["nmap", "nikto", "whatweb", "gobuster", "ffuf", "sqlmap", "nuclei", "hydra", "curl", "dig", "whois"];
/** Con cualquiera de estos nombres cuenta como instalado. */
const ALIASES: Record<string, string[]> = { python: ["python", "python3", "py"] };
const WINDOWS_EXTS = [".exe", ".cmd", ".bat", ".com"];
const SMALL_CONTEXT_TOKENS = 32_000;
const CACHE_MS = 5 * 60_000;

/** ¿Está el programa en el PATH? Sin lanzarlo. Devuelve su ruta o null. */
export function findOnPath(name: string, pathValue = process.env.PATH ?? process.env.Path ?? "", windows = process.platform === "win32"): string | null {
	const files = windows ? WINDOWS_EXTS.map((ext) => name + ext) : [name];
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) continue;
		for (const file of files) {
			try {
				const st = lstatSync(join(dir, file));
				// El python de la Microsoft Store es un acceso vacío que solo abre la tienda: no está instalado.
				if (windows && /^py/i.test(name) && /WindowsApps/i.test(dir) && st.size === 0) continue;
				return join(dir, file);
			} catch {
				/* no está en esta carpeta */
			}
		}
	}
	return null;
}

export function osLabel(): string {
	if (process.platform === "win32") return `${version()} (${arch()})`;
	if (process.platform === "darwin") return `macOS ${release()} (${arch()})`;
	let pretty = "";
	try {
		pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync("/etc/os-release", "utf-8"))?.[1] ?? "";
	} catch {
		/* sin /etc/os-release */
	}
	return `${pretty || "Linux"} (${arch()})`;
}

const programCache = new Map<string, { at: number; value: EnvironmentFacts["programs"] }>();

function programs(names: string[]): EnvironmentFacts["programs"] {
	const key = names.join(",");
	const hit = programCache.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
	const found: string[] = [];
	const missing: string[] = [];
	for (const name of names) ((ALIASES[name] ?? [name]).some((n) => findOnPath(n)) ? found : missing).push(name);
	const value = { found, missing };
	programCache.set(key, { at: Date.now(), value });
	return value;
}

/** Los datos del equipo. `shell`: la consola de la tool terminal, si la tiene. */
export function collectEnvironment(opts: { hacking?: boolean; shell?: EnvironmentFacts["shell"] } = {}): EnvironmentFacts {
	return {
		os: osLabel(),
		windows: process.platform === "win32",
		docker: existsSync("/.dockerenv"),
		home: homedir(),
		shell: opts.shell,
		programs: programs(opts.hacking ? [...DEV_PROGRAMS, ...HACKING_PROGRAMS] : DEV_PROGRAMS),
	};
}

const MODE_LABELS: Record<ChatMode, string> = { chat: "Chat", code: "Code", hacking: "Hacking" };

function permissionsText(v: EnvironmentView): string {
	if (v.approvalMode === "deny") return "las acciones con efectos (comandos, escribir archivos) están bloqueadas en Ajustes";
	if (v.permissions === "plan") return "Planear, solo lectura";
	if (v.permissions === "bypass" || v.approvalMode === "allow") return "sin preguntar; lo que hagas se ejecuta directo, así que cuidado con borrar o sobrescribir";
	if (v.permissions === "auto") return "Automático; comandos y archivos van sin preguntar, salvo lo destructivo";
	return "Preguntar; leer y buscar no pide permiso, tampoco los comandos que solo miran (ls, cat, grep, git status) dentro del proyecto; el resto de comandos y escribir archivos sí (el usuario lo aprueba con un clic): pide lo justo";
}

/** El bloque `## Entorno` del system prompt. */
export function formatEnvironment(f: EnvironmentFacts, v: EnvironmentView): string {
	const has = (t: string) => v.tools.includes(t);
	const lines = [`- Sistema: ${f.os}${f.docker ? ", dentro de un contenedor Docker (solo ves lo que hay dentro)" : ""}. Carpeta personal: ${f.home}`];
	if (has("terminal") && f.shell) {
		const powershell = f.shell.kind === "pwsh" || f.shell.kind === "powershell";
		const syntax = powershell ? " Escribe comandos de PowerShell (Get-ChildItem, Select-String…), no de bash." : "";
		const exec = has("exec") && f.windows ? " La tool exec usa cmd.exe, no PowerShell." : "";
		lines.push(`- Terminal (tool terminal): ${f.shell.name}, ahora en ${f.shell.cwd}.${syntax}${exec}`);
	} else if (has("exec")) {
		lines.push(`- Comandos (tool exec): ${f.windows ? "cmd.exe" : "sh"}, un comando corto por llamada.`);
	}
	if ((has("terminal") || has("exec")) && f.programs.found.length + f.programs.missing.length) {
		const missing = f.programs.missing.length ? ` No están: ${f.programs.missing.join(", ")}.` : "";
		lines.push(`- Programas instalados: ${f.programs.found.join(", ") || "ninguno de los habituales"}.${missing}`);
	}
	lines.push(`- Modo ${MODE_LABELS[v.mode]}. Permisos: ${permissionsText(v)}.`);
	if (v.contextLimit && v.contextLimit < SMALL_CONTEXT_TOKENS) {
		lines.push(`- Tu contexto es chico (unos ${Math.round(v.contextLimit / 1000)} mil tokens): pide resultados pequeños (búsquedas concretas, lecturas por tramos).`);
	}
	return `## Entorno\n${lines.join("\n")}`;
}

export type ToolGuideOptions = {
	mode: ChatMode;
	planning: boolean;
	/** Ya va el bloque «Control del PC», que explica la terminal y el navegador. */
	pcBlock: boolean;
	/** El control del PC está apagado en Ajustes. */
	pcControlOff: boolean;
};

/**
 * El bloque `## Qué herramienta usar`: una línea por tarea, solo con las herramientas que el modelo
 * tiene en esta respuesta (cambian con el modo, los permisos y el modo ahorro), y lo que le falta.
 */
export function buildToolGuide(tools: string[], o: ToolGuideOptions): string {
	const has = (t: string) => tools.includes(t);
	const lines: string[] = [];
	if (has("project")) {
		const change = o.planning ? "" : ", edit (cambiar un trozo), write (archivo nuevo)";
		lines.push(`- Proyecto: project → find (archivos por nombre), search (palabras en una misma línea; con | separas alternativas), read (un tramo, con line y lines)${change}. Leer y buscar no pide permiso: úsala antes que la terminal.`);
	}
	if (has("terminal") && !o.pcBlock) lines.push("- Comandos, pruebas, instalar: terminal (action=run); el usuario lo ve en vivo.");
	if (has("git")) lines.push("- Historial y cambios de un repositorio: git (status, log y diff no piden permiso).");
	if (has("list_dir_system") || has("read_file_system")) {
		lines.push(`- Archivos ${has("project") ? "fuera del proyecto" : "del equipo"}: list_dir_system y read_file_system (ruta completa; line y lines para un tramo).`);
	}
	if (has("search_web") || has("fetch_url")) {
		const browser = has("browser") && !o.pcBlock ? "; browser si hay que pulsar algo o la página necesita JavaScript" : "";
		lines.push(`- Internet: search_web encuentra; fetch_url lee (offset para seguir, find para ir a lo que buscas)${browser}.`);
	}
	// Con un proyecto delante, los modelos confunden estas con las del proyecto.
	if (has("project") && has("read_file")) lines.push("- read_file, write_file y list_dir son solo de tus notas (la carpeta de Aku), no del proyecto.");
	if (has("memory_search")) lines.push("- Lo ya hablado o guardado: memory_search antes de decir que no lo sabes.");
	if (has("todo")) lines.push("- Trabajo de 3 pasos o más: lleva la lista con todo (el usuario la ve).");

	const missing: string[] = [];
	if (o.mode !== "chat" && !has("project")) {
		missing.push("archivos de proyecto (este chat no tiene carpeta: el usuario la elige con el botón de carpeta de la caja de escribir, en un chat nuevo)");
	}
	if (!has("terminal") && !has("exec") && o.pcControlOff && !o.planning) missing.push("terminal ni control del PC (están apagados en Ajustes)");
	if (missing.length) lines.push(`- No tienes: ${missing.join("; ")}. Si hacen falta, díselo al usuario; no inventes resultados.`);
	return lines.length ? `## Qué herramienta usar\n${lines.join("\n")}` : "";
}
