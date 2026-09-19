import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "../../config/config.js";

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

/** Devuelve la descripción de la acción si necesita aprobación, o null si es segura. */
export function describeRiskyAction(tool: string, args: Record<string, unknown>): string | null {
	switch (tool) {
		case "exec": {
			const command = str(args.command).trim();
			const first = command.split(/\s+/)[0]?.toLowerCase() ?? "";
			const allow = getConfig().execAllowlist.map((c) => c.toLowerCase());
			if (first && allow.includes(first) && !SHELL_META.test(command)) return null;
			return `Ejecutar comando: ${command}${args.workingDir ? ` (en ${str(args.workingDir)})` : ""}`;
		}
		case "execute_python":
			return `Ejecutar código Python:\n${str(args.code).slice(0, 600)}`;
		case "write_file_system":
			return `Escribir el archivo ${str(args.path)} (${str(args.content).length} caracteres)`;
		case "read_file_system":
			return `Leer el archivo ${str(args.path)}`;
		case "self_modify":
			return `Modificar el código de Shiro: ${str(args.file)}`;
		case "git": {
			const command = str(args.command).trim();
			const sub = command.split(/\s+/)[0] ?? "";
			return READ_ONLY_GIT.has(sub) && !SHELL_META.test(command) ? null : `Ejecutar git ${command}`;
		}
		case "cron_create":
			return args.action === "exec" ? `Programar el comando "${str(args.command)}" (${str(args.expression)})` : null;
		case "channel_create":
			return `Crear el canal ${str(args.name)} (${str(args.type)})`;
		default:
			return null;
	}
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
