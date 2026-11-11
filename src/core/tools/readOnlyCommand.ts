/**
 * Comandos que solo miran (ls, cat, grep, git status…). Dentro de una carpeta del proyecto del chat
 * van sin pedir permiso, como `project read`: el usuario ya eligió esa carpeta. Fuera de ahí, o si el
 * comando puede salir de la carpeta, encadenar otros o escribir, se pregunta como siempre.
 * Va por lista de permitidos: lo que no está aquí, pregunta.
 */
import { resolve } from "node:path";
import { currentProject } from "../projects/projects.js";
import { isWithinRoot } from "./paths.js";

/** Encadenar, redirigir, variables, subcomandos, la carpeta personal (~) y variables de cmd (%). */
const UNSAFE_CHARS = /[;&`$(){}<>\n\r%~]/;
/** Una ruta completa (C:\, /etc, \\servidor) o subir de carpeta: el comando miraría fuera del proyecto. */
const LEAVES_FOLDER = /[A-Za-z]:[\\/]|(^|[\s"'=,])[\\/]|\.\./;

const READ_ONLY = new Set([
	"ls", "dir", "pwd", "cd", "cat", "type", "head", "tail", "wc", "nl", "grep", "egrep", "rg", "findstr", "find", "tree", "stat", "file", "du",
	"which", "whoami", "hostname", "echo", "sort", "uniq", "cut",
	"get-childitem", "gci", "get-content", "gc", "get-location", "gl", "set-location", "sl", "test-path", "select-string", "sls", "get-item", "gi",
	"measure-object", "measure", "select-object", "select", "get-command", "gcm", "git",
]);
/** Programas a los que solo se les deja preguntar la versión. */
const VERSION_ONLY = new Set(["node", "npm", "pnpm", "yarn", "python", "python3", "pip", "go", "cargo", "rustc", "java", "docker", "tsc"]);
const VERSION_ARGS = new Set(["-v", "-V", "--version", "version"]);

/** Opciones que hacen escribir, borrar o ejecutar a un comando que normalmente solo lee. */
const BANNED_ARGS: Record<string, RegExp> = {
	find: /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/i,
	rg: /^--(pre|pre-glob|hostname-bin)\b/i,
	sort: /^(-o|--output)\b/i,
	tree: /^-o$/i,
	"select-string": /^-(literalpath)$/i,
};

const GIT_READ = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files"]);
/** `branch` y `remote` solo listan con estas opciones (con otras crean, borran o cambian). */
const GIT_LIST_ARGS: Record<string, Set<string>> = {
	branch: new Set(["-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--list", "--verbose", "--show-current"]),
	remote: new Set(["-v", "--verbose"]),
};

/** ¿Estos argumentos de git solo leen? (`status`, `log -5`…; sin `--output` ni `--no-index`) */
export function isReadOnlyGitArgs(args: readonly string[]): boolean {
	const [sub = "", ...rest] = args;
	if (!GIT_READ.has(sub)) return false;
	if (rest.some((a) => /^--(output|no-index)\b/.test(a))) return false;
	const listArgs = GIT_LIST_ARGS[sub];
	return !listArgs || rest.every((a) => listArgs.has(a));
}

function words(segment: string): string[] {
	return segment
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => w.replace(/^["']|["']$/g, ""));
}

/** ¿El comando solo mira y no puede salir de la carpeta donde corre? Con `|` vale si cada parte lo cumple. */
export function isReadOnlyCommand(command: string): boolean {
	const text = command.trim();
	if (!text || text.length > 500 || UNSAFE_CHARS.test(text) || LEAVES_FOLDER.test(text)) return false;
	return text.split("|").every((segment) => {
		const [first = "", ...args] = words(segment);
		const name = first.toLowerCase().replace(/\.exe$/, "");
		if (VERSION_ONLY.has(name)) return args.length === 1 && VERSION_ARGS.has(args[0]!);
		if (!READ_ONLY.has(name)) return false;
		if (name === "git") return isReadOnlyGitArgs(args);
		const banned = BANNED_ARGS[name];
		return !banned || !args.some((a) => banned.test(a));
	});
}

/** ¿La carpeta está dentro de una de las que el usuario vinculó al proyecto del chat? */
export function isProjectDir(dir: string | undefined): boolean {
	if (!dir) return false;
	return (currentProject()?.folders ?? []).some((f) => isWithinRoot(dir, f.path, true));
}

/** Si es `cd <carpeta>` a secas, a dónde lleva; si no, undefined. */
function cdTarget(command: string, cwd: string | undefined): string | undefined {
	const m = /^(?:cd|set-location|sl)\s+(["']?)([^"']+)\1$/i.exec(command.trim());
	if (!m || UNSAFE_CHARS.test(m[2]!)) return undefined;
	return resolve(cwd ?? ".", m[2]!.trim());
}

/**
 * Comandos de solo lectura que corren dentro del proyecto del chat: no hace falta preguntar.
 * Entrar a una carpeta del proyecto (`cd`) tampoco pregunta, aunque la terminal esté fuera, y se
 * pueden encadenar con `&&` o `;` (p. ej. `cd C:\proyecto && ls`) si cada parte lo cumple donde le toca correr.
 */
export function isFreeReadCommand(command: string, cwd: string | undefined): boolean {
	const parts = command.trim().split(/\s*(?:&&|;)\s*/);
	if (parts.length > 6) return false;
	let where = cwd;
	for (const part of parts) {
		const target = cdTarget(part, where);
		if (target !== undefined) {
			if (!isProjectDir(target)) return false;
			where = target;
		} else if (!isProjectDir(where) || !isReadOnlyCommand(part)) return false;
	}
	return true;
}
