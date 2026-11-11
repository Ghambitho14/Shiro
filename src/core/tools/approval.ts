import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "../../config/config.js";
import { classifyOpenTarget } from "../pc/pc.js";
import { isMcpToolName, mcpManager } from "../mcp/McpManager.js";
import { shiroBrowser } from "../browser/browser.js";
import { hostOf } from "../browser/pageModel.js";
import { currentProject, resolveProjectPath } from "../projects/projects.js";
import { terminal } from "../terminal/terminal.js";
import type { PermissionMode } from "../agent/chatMode.js";
import { gitWorkDir, isGitReadableDir } from "./gitDir.js";

/**
 * Aprobación de acciones peligrosas.
 *
 * Cada interfaz (terminal, web) registra un "approver" para la duración de una respuesta
 * con runWithApprover(). Las tools peligrosas llaman a requestApproval() antes de actuar.
 * Si no hay approver (WhatsApp, API sin streaming, cron), la acción se bloquea.
 */

export type ApprovalRequest = {
	tool: string;
	/** Descripción legible de lo que se va a hacer. */
	summary: string;
};

export type Approver = (req: ApprovalRequest) => Promise<boolean>;

/** Una respuesta: quién aprueba, cómo se quiso trabajar y si ya se leyó contenido de afuera (webs, servidores MCP). */
const approverStore = new AsyncLocalStorage<{ approver?: Approver; externalRead: boolean; permissions: PermissionMode }>();

export function runWithApprover<T>(approver: Approver | undefined, fn: () => Promise<T>, permissions: PermissionMode = "ask"): Promise<T> {
	// Un ayudante creado tras leer una web puede traer esas órdenes en su encargo: lo leído se hereda.
	return approverStore.run({ approver, externalRead: approverStore.getStore()?.externalRead ?? false, permissions }, fn);
}

/** Apunta que en esta respuesta el modelo leyó contenido de afuera (lo llama executeToolSafeScoped). */
export function noteExternalRead(): void {
	const store = approverStore.getStore();
	if (store) store.externalRead = true;
}

function externalReadInThisResponse(): boolean {
	return approverStore.getStore()?.externalRead === true;
}

const AFTER_WEB = " (en esta respuesta leí contenido de una web o de un servidor MCP)";

const SHELL_META = /[;&|`$(){}\[\]<>\n\r]/;
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files"]);
/** `branch` y `remote` solo listan con estas opciones (con otras crean, borran o cambian). */
const GIT_LIST_ARGS: Record<string, Set<string>> = {
	branch: new Set(["-a", "-r", "-v", "-vv", "-l", "--all", "--remotes", "--list", "--verbose", "--show-current"]),
	remote: new Set(["-v", "--verbose"]),
};

/**
 * git sin pedir permiso: solo subcomandos que leen, en el workspace o en una carpeta del proyecto del chat, sin encadenar comandos,
 * sin escribir archivos (`--output`) ni leer fuera del repositorio (`--no-index`).
 */
function isReadOnlyGit(command: string, repoPath: string): boolean {
	if (SHELL_META.test(command)) return false;
	const [sub = "", ...rest] = command.replace(/^git\s+/i, "").split(/\s+/);
	if (!READ_ONLY_GIT.has(sub)) return false;
	if (rest.some((a) => /^--(output|no-index)\b/.test(a))) return false;
	const listArgs = GIT_LIST_ARGS[sub];
	if (listArgs && !rest.every((a) => listArgs.has(a))) return false;
	return isGitReadableDir(gitWorkDir(repoPath));
}

function str(v: unknown): string {
	return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

/** Comandos de la lista "sin preguntar" (Ajustes), siempre que no encadenen otros: null. */
function describeCommand(prefix: string, command: string, where = ""): string | null {
	const first = command.split(/\s+/)[0]?.toLowerCase() ?? "";
	const allow = getConfig().execAllowlist.map((c) => c.toLowerCase());
	if (first && allow.includes(first) && !SHELL_META.test(command)) return null;
	return `${prefix}: ${command}${where}`;
}

/** Teclear en la terminal siempre se pregunta: en el prompt sería ejecutar un comando. Una contraseña no se enseña. */
function describeTerminalWrite(args: Record<string, unknown>): string {
	const parts: string[] = [];
	if (args.text) parts.push(terminal.waitingForPassword() ? "una contraseña (oculta)" : `"${str(args.text).slice(0, 400)}"`);
	if (args.keys) parts.push(`las teclas ${str(args.keys)}`);
	const enter = args.enter === undefined ? Boolean(args.text) : args.enter === true || args.enter === "true";
	return `Escribir en la terminal: ${parts.join(" y ") || "Enter"}${enter && parts.length ? " y pulsar Enter" : ""}`;
}

/** Devuelve la descripción de la acción si necesita aprobación, o null si es segura. */
export function describeRiskyAction(tool: string, args: Record<string, unknown>): string | null {
	switch (tool) {
		case "exec":
			return describeCommand("Ejecutar comando", str(args.command).trim(), args.workingDir ? ` (en ${str(args.workingDir)})` : "");
		case "project": {
			if (args.action !== "write" && args.action !== "edit") return null;
			const project = currentProject();
			const where = `${str(args.path)}${project ? ` en el proyecto «${project.name}»` : ""}`;
			if (args.action === "write") return `Escribir el archivo ${where} (${str(args.content).length} caracteres)`;
			// Se enseña el antes y el después para que el usuario vea qué cambia.
			const clip = (v: unknown) => (str(v).length > 400 ? `${str(v).slice(0, 400)}…` : str(v));
			const all = args.replace_all === true || args.replace_all === "true" ? " (todas las veces que aparece)" : "";
			return `Cambiar un trozo de ${where}${all}:\n— Antes:\n${clip(args.old_text)}\n— Después:\n${clip(args.new_text) || "(se borra)"}`;
		}
		case "claude_code": {
			// Siempre se pregunta: Claude Code puede cambiar archivos y usa la suscripción del usuario.
			const where = str(args.folder).trim() || currentProject()?.name || "la carpeta del proyecto";
			return `Pedir a Claude Code (tu suscripción) que trabaje en ${where}${args.continue === true ? ", siguiendo lo anterior" : ""}: "${str(args.task).trim().slice(0, 500)}"`;
		}
		case "terminal":
			if (args.action === "write") return describeTerminalWrite(args);
			return args.action === "run" ? describeCommand("Ejecutar en la terminal", str(args.command).trim()) : null;
		case "browser": {
			// Leer y moverse por la web no pide permiso; pulsar o escribir sí (puede enviar formularios o comprar).
			if (args.action !== "click" && args.action !== "type") return null;
			const ref = Number(args.ref);
			const what = shiroBrowser.describeRef(ref) ?? `el elemento [${str(args.ref)}]`;
			const site = shiroBrowser.state.url ? ` en ${hostOf(shiroBrowser.state.url)}` : "";
			if (args.action === "click") return `Hacer clic en ${what}${site}`;
			return `Escribir "${str(args.text).slice(0, 300)}" en ${what}${site}${args.enter === true || args.enter === "true" ? " y pulsar Enter" : ""}`;
		}
		// Guardar en la memoria o en la carpeta de Shiro (SOUL.md, MEMORY.md…) queda para siempre:
		// después de leer una web se pregunta, para que una página no deje órdenes guardadas.
		case "memory_add":
			return externalReadInThisResponse() ? `Guardar en tu memoria: "${str(args.content).slice(0, 400)}"${AFTER_WEB}` : null;
		case "write_file":
			return externalReadInThisResponse()
				? `Escribir el archivo ${str(args.path)} en la carpeta de Aku (${str(args.content).length} caracteres)${AFTER_WEB}`
				: null;
		case "write_file_system":
			return `Escribir el archivo ${str(args.path)} (${str(args.content).length} caracteres)`;
		case "read_file_system": {
			// Dentro de una carpeta del proyecto del chat es lo mismo que project read: el usuario ya la eligió.
			const project = currentProject();
			const path = str(args.path).trim();
			if (project && /^([A-Za-z]:[\\/]|\/)/.test(path) && resolveProjectPath(project, path)) return null;
			return `Leer el archivo ${str(args.path)}`;
		}
		case "git": {
			const command = str(args.command).trim();
			const repoPath = str(args.repoPath).trim();
			if (isReadOnlyGit(command, repoPath)) return null;
			return `Ejecutar git ${command}${repoPath && repoPath !== "." ? ` (en ${repoPath})` : ""}`;
		}
		case "cron_create":
			return args.action === "exec" ? `Programar el comando "${str(args.command)}" (${str(args.expression)})` : null;

		// ---------- Control del PC ----------
		case "pc_open": {
			const t = classifyOpenTarget(str(args.target));
			if (t.kind === "path" && (t.executable || t.remote)) return `Abrir/ejecutar el archivo ${t.value}`;
			if (t.kind === "uri" && !t.safe) return `Abrir el enlace ${t.value}`;
			// Un script por nombre (sin ruta) también se ejecutaría: se pregunta.
			if (t.kind === "app" && /\.(bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msc|reg|hta|scr|pif|lnk|url|jar)$/i.test(t.value)) {
				return `Ejecutar ${t.value}`;
			}
			return null;
		}
		case "pc_keyboard": {
			const parts: string[] = [];
			if (args.text) parts.push(`escribir "${str(args.text).slice(0, 400)}"`);
			if (args.keys) parts.push(`pulsar ${str(args.keys)}`);
			const where = args.window ? ` en la ventana "${str(args.window)}"` : " en la ventana activa";
			return `Usar el teclado: ${parts.join(" y ")}${where}`;
		}
		case "pc_mouse": {
			const action = str(args.action);
			if (action === "move" || action.startsWith("scroll")) return null;
			const labels: Record<string, string> = { click: "Hacer clic", double_click: "Hacer doble clic", right_click: "Hacer clic derecho" };
			const where = args.x !== undefined && args.y !== undefined ? ` en (${str(args.x)}, ${str(args.y)}) de la pantalla` : " donde está el ratón";
			return `${labels[action] ?? "Usar el ratón"}${where}`;
		}
		case "pc_clipboard":
			return args.action === "read" ? "Leer lo que tienes copiado en el portapapeles" : null;
		case "pc_processes":
			return args.action === "kill" ? `Cerrar a la fuerza el programa "${str(args.name)}" (se pierde lo no guardado)` : null;
		case "pc_power": {
			const minutes = args.delay_minutes === undefined ? 1 : Number(args.delay_minutes);
			const when = minutes > 0 ? ` en ${minutes} min` : " ahora";
			const labels: Record<string, string> = {
				sleep: "Suspender el PC",
				shutdown: `Apagar el PC${when}`,
				restart: `Reiniciar el PC${when}`,
				logoff: "Cerrar la sesión de Windows",
			};
			return labels[str(args.action)] ?? null;
		}
		default:
			return isMcpToolName(tool) ? describeMcpAction(tool, args) : null;
	}
}

/**
 * Las tools de servidores MCP pueden hacer cualquier cosa (mandar correos, borrar archivos…):
 * se pregunta siempre, salvo las que el usuario marcó como "sin preguntar" en Ajustes → Conectores MCP.
 */
function describeMcpAction(tool: string, args: Record<string, unknown>): string | null {
	const info = mcpManager.lookup(tool);
	if (info?.alwaysAllow) return null;
	const shown = Object.entries(args ?? {})
		.slice(0, 6)
		.map(([k, v]) => {
			const s = str(v);
			return `${k}: ${s.length > 160 ? s.slice(0, 159) + "…" : s}`;
		});
	const name = info ? `"${info.tool}" del servidor MCP ${info.server}` : tool;
	return `Usar la herramienta ${name}${shown.length ? `\n${shown.join("\n")}` : ""}`;
}

/**
 * Tools cuyo permiso el usuario puede dar "para toda la conversación" (acciones repetitivas
 * de manejar el PC). Comandos, archivos del sistema y apagar el equipo se preguntan siempre.
 */
export const REMEMBERABLE_TOOLS = new Set(["pc_open", "pc_keyboard", "pc_mouse", "pc_clipboard", "browser"]);

/** true si se ofrece "Permitir siempre en este chat" (también cada tool de un servidor MCP). */
export function canRememberApproval(tool: string): boolean {
	return REMEMBERABLE_TOOLS.has(tool) || isMcpToolName(tool);
}

/** Lo único que «Automático» hace sin preguntar: comandos y archivos. El resto (web, teclado, MCP, tareas programadas…) se pregunta. */
const AUTO_TOOLS = new Set(["exec", "terminal", "git", "project", "write_file", "write_file_system", "read_file_system", "memory_add", "claude_code"]);

/** Borrar, formatear, apagar, reescribir git, ejecutar lo que baje de internet. Va por palabras: no es infalible. */
const DESTRUCTIVE_COMMAND = new RegExp(
	[
		// Solo donde empieza un comando: «npm run format» o «cat rm.txt» no borran nada.
		String.raw`(^\s*|[;&|("'` + "`" + String.raw`]\s*|\b(sudo|xargs)\s+)(rm|rmdir|rd|del|erase|ri|remove-item|remove-itemproperty|clear-content|clear-recyclebin|clear-disk|format|format-volume|diskpart|fdisk|dd|shred|shutdown|reboot|halt|poweroff|stop-computer|restart-computer|taskkill|stop-process|kill|killall|pkill)(\.exe)?(?=$|[\s;&|)"'])`,
		String.raw`\bfind\b.*\s-delete\b`,
		String.raw`\bmkfs\b|\bmkfs\.`,
		String.raw`\breg(\.exe)?\s+delete\b`,
		String.raw`\bgit\s+(push\b.*(\s-f\b|--force)|reset\s+--hard\b|clean\b|checkout\s+--|branch\s+-d\b|rebase\b|filter-branch\b|gc\s+--prune\b)`,
		String.raw`\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b.*\|\s*(sudo\s+)?(sh|bash|zsh|iex|invoke-expression|pwsh|powershell|python\d?)\b`,
		String.raw`>\s*/dev/(sd|nvme|disk)`,
		String.raw`\bchmod\s+-r\b.*\b777\b`,
	].join("|"),
	"i",
);

/** ¿Este comando puede borrar o romper algo sin vuelta atrás? */
export function isDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_COMMAND.test(command);
}

/** «Automático» sigue preguntando esto: lo que no es un comando o un archivo, lo destructivo y teclear una contraseña. */
export function isHardToUndo(tool: string, args: Record<string, unknown>): boolean {
	if (!AUTO_TOOLS.has(tool)) return true;
	if (tool === "terminal" && args.action === "write" && terminal.waitingForPassword()) return true;
	const typed = tool === "exec" || tool === "terminal" ? str(args.command ?? args.text) : tool === "git" ? `git ${str(args.command)}` : "";
	return isDestructiveCommand(typed);
}

export async function requestApproval(tool: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
	const summary = describeRiskyAction(tool, args);
	if (!summary) return { ok: true };

	const mode = getConfig().approvalMode;
	if (mode === "allow") return { ok: true };
	if (mode === "deny") return { ok: false, error: `Acción bloqueada por configuración (approvalMode=deny): ${summary}` };

	const store = approverStore.getStore();
	if (store?.approver) {
		if (store.permissions === "bypass") return { ok: true };
		// Tras leer una web o un MCP se vuelve a preguntar todo: podría traer órdenes escondidas.
		if (store.permissions === "auto" && !store.externalRead && !isHardToUndo(tool, args)) return { ok: true };
	}

	const approver = store?.approver;
	if (!approver) {
		return {
			ok: false,
			error: `Esta acción necesita aprobación del usuario y este canal no puede pedirla: ${summary}. Dile al usuario que lo haga desde la terminal (npm run tui) o la web.`,
		};
	}
	const approved = await approver({ tool, summary });
	return approved ? { ok: true } : { ok: false, error: `El usuario rechazó la acción: ${summary}. No la intentes de nuevo salvo que te lo pida.` };
}
