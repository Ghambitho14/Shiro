import { existsSync, statSync } from "node:fs";
import { claudeCodeLauncher, runClaudeCode, type ClaudeEvent } from "../../claudeCode/claudeCode.js";
import { currentProject, getProject, projectSources, resolveProjectPath } from "../../projects/projects.js";
import { terminal } from "../../terminal/terminal.js";

const DEFAULT_MINUTES = 20;
const MAX_MINUTES = 60;
/** Lo que vuelve al modelo (los locales tienen poco contexto). */
const MAX_RESULT_CHARS = 6000;

/** Carpeta del proyecto donde trabajará Claude Code: la indicada o, si solo hay una, esa. */
export function claudeCodeFolder(folderArg: string): { full: string; path: string } | { error: string } {
	const active = currentProject();
	const p = active ? getProject(active.id) ?? active : undefined;
	if (!p) return { error: "Claude Code solo trabaja en un proyecto: abre un chat del proyecto que tenga la carpeta de tu código." };
	const folders = projectSources(p).filter((s) => s.kind === "folder" && s.exists);
	if (!folders.length) return { error: `El proyecto «${p.name}» no tiene carpetas vinculadas. Vincula la carpeta de tu código en la página del proyecto.` };
	const arg = folderArg.trim();
	if (!arg) {
		if (folders.length === 1) return { full: folders[0]!.root, path: folders[0]!.label };
		return { error: `Indica la carpeta (folder): ${folders.map((f) => f.label).join(", ")}.` };
	}
	const target = resolveProjectPath(p, arg);
	if (!target || target.source.kind !== "folder") return { error: `${arg} no es una carpeta vinculada del proyecto. Carpetas: ${folders.map((f) => f.label).join(", ")}.` };
	if (!existsSync(target.full) || !statSync(target.full).isDirectory()) return { error: `${target.path} no es una carpeta.` };
	return { full: target.full, path: target.path };
}

/** Una línea del panel Terminal por cada paso de Claude Code. */
function progressLine(e: ClaudeEvent): string {
	if (e.kind === "tool") return `▸ ${e.name}${e.detail ? `: ${e.detail}` : ""}\n`;
	if (e.kind === "text") return `${e.text}\n`;
	return "";
}

/** claude_code: encargar una tarea de programación a Claude Code (la suscripción del usuario) en una carpeta del proyecto. */
export async function executeClaudeCode(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const launcher = claudeCodeLauncher();
	if (!launcher) {
		return { ok: false, content: "Claude Code no está instalado en este equipo (o no está en el PATH). Instálalo y entra con tu cuenta: claude → /login." };
	}
	const task = String(args.task ?? "").trim();
	if (!task) return { ok: false, content: "Indica la tarea (task)." };
	const folder = claudeCodeFolder(typeof args.folder === "string" ? args.folder : "");
	if ("error" in folder) return { ok: false, content: folder.error };
	const minutes = Math.min(MAX_MINUTES, Math.max(1, Number(args.timeout_minutes) || DEFAULT_MINUTES));
	const cont = args.continue === true;

	// El botón de parar del panel Terminal también detiene a Claude Code.
	const stop = new AbortController();
	const view = terminal.external(`Claude Code${cont ? " (sigue)" : ""}: ${task.replace(/\s+/g, " ").slice(0, 200)}`, folder.full, () => stop.abort());
	const r = await runClaudeCode({
		signal: stop.signal,
		launcher,
		task,
		cwd: folder.full,
		continue: cont,
		timeoutMs: minutes * 60_000,
		onEvent: (e) => view.write(progressLine(e)),
		onStderr: (text) => view.write(text, true),
	});
	const steps = r.turns !== undefined ? ` · ${r.turns} pasos` : "";
	view.write(r.ok ? `\n✓ Terminado${steps}\n` : `\n✗ ${r.text}\n`, !r.ok);
	view.end(r.ok ? 0 : 1);

	if (!r.ok) return { ok: false, content: r.text };
	const text = r.text.length > MAX_RESULT_CHARS ? r.text.slice(0, MAX_RESULT_CHARS) + "\n…(recortado)" : r.text;
	return { ok: true, content: `Claude Code terminó en ${folder.path}${steps}. Su respuesta:\n\n${text}` };
}
