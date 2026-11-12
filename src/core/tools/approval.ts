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
import { currentAgentRun } from "../agent/runContext.js";
import { targetsOutOfScope } from "../pentest/engagement.js";
import { isFreeReadCommand, isReadOnlyGitArgs } from "./readOnlyCommand.js";

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

/**
 * git sin pedir permiso: solo subcomandos que leen, en el workspace o en una carpeta del proyecto del chat, sin encadenar comandos,
 * sin escribir archivos (`--output`) ni leer fuera del repositorio (`--no-index`).
 */
function isReadOnlyGit(command: string, repoPath: string): boolean {
	if (SHELL_META.test(command)) return false;
	if (!isReadOnlyGitArgs(command.replace(/^git\s+/i, "").split(/\s+/))) return false;
	return isGitReadableDir(gitWorkDir(repoPath));
}

function str(v: unknown): string {
	return typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
}

/** Comandos de la lista "sin preguntar" (Ajustes), siempre que no encadenen otros: null. */
function describeCommand(prefix: string, command: string, where = "", cwd?: string): string | null {
	// Mirar dentro del proyecto del chat no se pregunta (como project read), salvo tras leer algo de afuera.
	if (!externalReadInThisResponse() && isFreeReadCommand(command, cwd)) return null;
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

/** Empieza así la tarjeta de un comando que apunta fuera del alcance del pentest: siempre se pregunta. */
export const OUT_OF_SCOPE_MARK = "⚠ FUERA DEL ALCANCE";

/**
 * En Hacking, con alcance anotado (tool pentest): qué objetivos del comando no están autorizados.
 * Devuelve el aviso para la tarjeta, o "" si todo está dentro (o no hay alcance con qué comparar).
 */
function scopeWarning(command: string): string {
	const run = currentAgentRun();
	if (run?.mode !== "hacking" || !run.sessionId || !command) return "";
	let check: ReturnType<typeof targetsOutOfScope>;
	try {
		check = targetsOutOfScope(run.sessionId, command);
	} catch {
		return "";
	}
	if (!check || (!check.outside.length && !check.excluded.length)) return "";
	const parts: string[] = [];
	if (check.excluded.length) parts.push(`marcado como fuera del alcance: ${check.excluded.join(", ")}`);
	if (check.outside.length) parts.push(`no está en el alcance: ${check.outside.join(", ")}`);
	return `${OUT_OF_SCOPE_MARK} (${parts.join("; ")}). Apruébalo solo si ese objetivo también es tuyo o está autorizado.
`;
}

/** Devuelve la descripción de la acción si necesita aprobación, o null si es segura. */
export function describeRiskyAction(tool: string, args: Record<string, unknown>): string | null {
	const summary = describeRiskyActionBase(tool, args);
	if (tool !== "exec" && !(tool === "terminal" && args.action === "run")) return summary;
	const warning = scopeWarning(str(args.command).trim());
	if (!warning) return summary;
	return warning + (summary ?? `Ejecutar: ${str(args.command).trim()}`);
}

function describeRiskyActionBase(tool: string, args: Record<string, unknown>): string | null {
	switch (tool) {
		case "exec":
			return describeCommand("Ejecutar comando", str(args.command).trim(), args.workingDir ? ` (en ${str(args.workingDir)})` : "", str(args.workingDir).trim() || undefined);
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
			return args.action === "run" ? describeCommand("Ejecutar en la terminal", str(args.command).trim(), "", terminal.shellInfo().cwd) : null;
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
			if (args.action === "exec") return `Programar el comando "${str(args.command)}" (${str(args.expression)})`;
			// Una tarea se repite sola: si la idea vino de algo leído afuera, el usuario lo confirma.
			return externalReadInThisResponse()
				? `Programar la tarea "${str(args.name)}" (${str(args.expression)}): ${str(args.prompt ?? args.message).slice(0, 300)}${AFTER_WEB}`
				: null;

		// ---------- Correo y calendario (Google) ----------
		case "email": {
			if (args.action !== "send") return null;
			const to = str(args.to).trim() || (args.reply_to_id ? "quien te escribió ese correo" : "(sin destinatario)");
			const cc = str(args.cc).trim() ? `\nCC: ${str(args.cc).trim()}` : "";
			const reply = args.reply_to_id ? " (respuesta)" : "";
			return `Enviar un correo${reply} a ${to}${cc}\nAsunto: ${str(args.subject).trim() || "(el del correo original)"}\n\n${str(args.body).slice(0, 1500)}`;
		}
		case "calendar": {
			if (args.action !== "create") return null;
			const attendees = Array.isArray(args.attendees) && args.attendees.length ? `\nSe enviará una invitación a: ${args.attendees.map(String).join(", ")}` : "";
			const where = str(args.location).trim() ? `, en ${str(args.location).trim()}` : "";
			return `Crear el evento «${str(args.title)}» el ${str(args.start)}${args.end ? ` hasta ${str(args.end)}` : ""}${where} en tu Google Calendar${attendees}`;
		}

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

/** Lo que sale en nombre del usuario: se pregunta siempre, sea cual sea el permiso del chat. */
export function alwaysAsksUser(tool: string, args: Record<string, unknown>): boolean {
	return (tool === "email" && args.action === "send") || (tool === "calendar" && args.action === "create");
}

export async function requestApproval(tool: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
	const summary = describeRiskyAction(tool, args);
	if (!summary) return { ok: true };

	const mode = getConfig().approvalMode;
	// Se preguntan siempre, también en «Automático» y «Omitir permisos»: un objetivo fuera del alcance del pentest,
	// enviar un correo y crear un evento del calendario (salen a otras personas en tu nombre).
	const alwaysAsk = summary.startsWith(OUT_OF_SCOPE_MARK) || alwaysAsksUser(tool, args);
	if (mode === "allow" && !alwaysAsk) return { ok: true };
	if (mode === "deny") return { ok: false, error: `Acción bloqueada por configuración (approvalMode=deny): ${summary}` };

	const store = approverStore.getStore();
	if (store?.approver && !alwaysAsk) {
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
