import { existsSync, statSync } from "node:fs";
import { extractText } from "../../projects/documents.js";
import {
	currentProject,
	formatSize,
	getProject,
	listProjectFiles,
	projectSources,
	resolveProjectPath,
	searchProject,
	writeProjectFile,
	type Project,
} from "../../projects/projects.js";

/** Caracteres que se devuelven en cada lectura (los modelos locales tienen poco contexto). */
const READ_CHUNK = 12_000;
const LIST_MAX_LINES = 300;

function sourcesHint(p: Project): string {
	return projectSources(p)
		.map((s) => `${s.label}/`)
		.join(", ");
}

/** project: listar, leer, buscar y escribir los archivos del proyecto del chat actual. */
export async function executeProject(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const active = currentProject();
	// Se relee por si el usuario añadió archivos o carpetas mientras Shiro trabajaba.
	const p = active ? getProject(active.id) ?? active : undefined;
	if (!p) return { ok: false, content: "Este chat no está en un proyecto." };
	const action = String(args.action ?? "list");
	const pathArg = typeof args.path === "string" ? args.path.trim() : "";
	const target = pathArg ? resolveProjectPath(p, pathArg) ?? undefined : undefined;
	if (pathArg && !target) {
		return { ok: false, content: `La ruta ${pathArg} no está en el proyecto. Las rutas empiezan por: ${sourcesHint(p)}` };
	}

	try {
		switch (action) {
			case "list": {
				if (target && !existsSync(target.full)) return { ok: false, content: `No existe ${target.path}.` };
				const files = listProjectFiles(p, target);
				if (!files.length) return { ok: true, content: target ? `${target.path} está vacía.` : "El proyecto aún no tiene archivos." };
				const lines = files.slice(0, LIST_MAX_LINES).map((f) => `${f.path} (${formatSize(f.size)})`);
				if (files.length > LIST_MAX_LINES) lines.push(`…y ${files.length - LIST_MAX_LINES} más. Indica path para ver una carpeta concreta.`);
				return { ok: true, content: lines.join("\n") };
			}
			case "read": {
				if (!target || !existsSync(target.full)) return { ok: false, content: `No existe ${pathArg}. Usa action=list para ver los archivos.` };
				if (statSync(target.full).isDirectory()) return { ok: false, content: `${target.path} es una carpeta: usa action=list con ese path.` };
				const text = await extractText(target.full);
				const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
				if (offset >= text.length && text.length) return { ok: false, content: `El archivo solo tiene ${text.length} caracteres.` };
				const chunk = text.slice(offset, offset + READ_CHUNK);
				const end = offset + chunk.length;
				const more = end < text.length ? `\n\n[…continúa: quedan ${text.length - end} caracteres. Sigue con offset=${end}.]` : "";
				const range = offset || more ? ` (caracteres ${offset}–${end} de ${text.length})` : "";
				return { ok: true, content: `Archivo: ${target.path}${range}\n\n${chunk}${more}` };
			}
			case "search": {
				const query = String(args.query ?? "").trim();
				const { results, partial } = await searchProject(p, query, target);
				const note = partial
					? `\n\n[Búsqueda parcial: hay demasiados archivos para mirarlos todos. Indica path con una carpeta concreta (p. ej. ${projectSources(p).at(-1)?.label ?? "Carpeta"}/subcarpeta) para buscar ahí.]`
					: "";
				if (!results.length) return { ok: true, content: `No encontré "${query}" en ${target ? target.path : "el proyecto"}. Prueba con otras palabras o lee los archivos.${note}` };
				return { ok: true, content: results.join("\n") + note };
			}
			case "write": {
				const r = writeProjectFile(p, pathArg, String(args.content ?? ""));
				return { ok: true, content: `Guardado ${r.path}.` };
			}
			default:
				return { ok: false, content: `Acción desconocida: ${action}. Usa list, read, search o write.` };
		}
	} catch (err) {
		return { ok: false, content: err instanceof Error ? err.message : String(err) };
	}
}
