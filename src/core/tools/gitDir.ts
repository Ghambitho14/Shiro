/** Dónde corre la tool git y dónde puede leer sin pedir permiso. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { currentProject } from "../projects/projects.js";
import { getWorkspaceDir } from "../../workspace.js";
import { isWithinRoot } from "./paths.js";

/** La carpeta indicada; si no se indica, la del proyecto del chat (la primera que exista) o la de Aku. */
export function gitWorkDir(repoPath = "."): string {
	const rel = repoPath.trim();
	if (!rel || rel === ".") {
		const folder = currentProject()?.folders.find((f) => existsSync(f.path));
		if (folder) return resolve(folder.path);
	}
	return resolve(getWorkspaceDir(), rel || ".");
}

/** La carpeta de Aku y las que el usuario vinculó al proyecto del chat: ahí `project` ya lee sin preguntar. */
export function isGitReadableDir(dir: string): boolean {
	if (isWithinRoot(dir, getWorkspaceDir(), true)) return true;
	return (currentProject()?.folders ?? []).some((f) => isWithinRoot(dir, f.path, true));
}
