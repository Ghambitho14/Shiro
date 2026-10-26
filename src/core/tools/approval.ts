import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "../../config/config.js";
import { classifyOpenTarget } from "../pc/pc.js";
import { isMcpToolName, mcpManager } from "../mcp/McpManager.js";
import { shiroBrowser } from "../browser/browser.js";
import { hostOf } from "../browser/pageModel.js";
import { currentProject } from "../projects/projects.js";

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

const approverStore = new AsyncLocalStorage<Approver | undefined>();

export function runWithApprover<T>(approver: Approver | undefined, fn: () => Promise<T>): Promise<T> {
	return approverStore.run(approver, fn);
}

const SHELL_META = /[;&|`$(){}\[\]<>\n\r]/;
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files"]);

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

/** Devuelve la descripción de la acción si necesita aprobación, o null si es segura. */
export function describeRiskyAction(tool: string, args: Record<string, unknown>): string | null {
	switch (tool) {
		case "exec":
			return describeCommand("Ejecutar comando", str(args.command).trim(), args.workingDir ? ` (en ${str(args.workingDir)})` : "");
		case "project": {
			if (args.action !== "write") return null;
			const project = currentProject();
			return `Escribir el archivo ${str(args.path)}${project ? ` en el proyecto «${project.name}»` : ""} (${str(args.content).length} caracteres)`;
		}
		case "terminal":
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
		case "write_file_system":
			return `Escribir el archivo ${str(args.path)} (${str(args.content).length} caracteres)`;
		case "read_file_system":
			return `Leer el archivo ${str(args.path)}`;
		case "git": {
			const command = str(args.command).trim();
			const sub = command.split(/\s+/)[0] ?? "";
			return READ_ONLY_GIT.has(sub) && !SHELL_META.test(command) ? null : `Ejecutar git ${command}`;
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

export async function requestApproval(tool: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
	const summary = describeRiskyAction(tool, args);
	if (!summary) return { ok: true };

	const mode = getConfig().approvalMode;
	if (mode === "allow") return { ok: true };
	if (mode === "deny") return { ok: false, error: `Acción bloqueada por configuración (approvalMode=deny): ${summary}` };

	const approver = approverStore.getStore();
	if (!approver) {
		return {
			ok: false,
			error: `Esta acción necesita aprobación del usuario y este canal no puede pedirla: ${summary}. Dile al usuario que lo haga desde la terminal (npm run tui) o la web.`,
		};
	}
	const approved = await approver({ tool, summary });
	return approved ? { ok: true } : { ok: false, error: `El usuario rechazó la acción: ${summary}. No la intentes de nuevo salvo que te lo pida.` };
}
