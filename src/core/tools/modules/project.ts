import { existsSync, statSync } from "node:fs";
import { currentResultBudget } from "../../agent/runContext.js";
import { extractText, isTextFile } from "../../projects/documents.js";
import {
	currentProject,
	editProjectFile,
	findProjectFiles,
	formatSize,
	getProject,
	listProjectFiles,
	projectSources,
	resolveProjectPath,
	searchProject,
	writeProjectFile,
	type Project,
} from "../../projects/projects.js";
import { sliceText } from "../textSlice.js";

const LIST_MAX_LINES = 300;
const FIND_MAX = 100;

function sourcesHint(p: Project): string {
	return projectSources(p)
		.map((s) => `${s.label}/`)
		.join(", ");
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** project: listar, encontrar, buscar, leer por partes, editar un trozo y escribir los archivos del proyecto del chat actual. */
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
				if (files.length > LIST_MAX_LINES) lines.push(`…y ${files.length - LIST_MAX_LINES} más. Indica path para ver una carpeta concreta, o usa action=find para buscar por nombre.`);
				return { ok: true, content: lines.join("\n") };
			}
			case "find": {
				const query = String(args.query ?? "").trim();
				if (target && !existsSync(target.full)) return { ok: false, content: `No existe ${target.path}.` };
				const { files, total, partial } = findProjectFiles(p, query, target, FIND_MAX);
				const where = target ? target.path : "el proyecto";
				if (!files.length) {
					return { ok: true, content: `No hay archivos con "${query}" en el nombre en ${where}. Prueba con otra palabra o un patrón (p. ej. *.ts), o busca dentro de los archivos con action=search.` };
				}
				const lines = files.map((f) => `${f.path} (${formatSize(f.size)})`);
				if (total > files.length) lines.push(`…y ${total - files.length} más: afina el nombre o indica path con una carpeta.`);
				if (partial) lines.push("[Hay demasiados archivos para mirarlos todos: indica path con una carpeta concreta.]");
				return { ok: true, content: lines.join("\n") };
			}
			case "read": {
				if (!target || !existsSync(target.full)) return { ok: false, content: `No existe ${pathArg}. Usa action=find para buscarlo por nombre o action=list para ver los archivos.` };
				if (statSync(target.full).isDirectory()) return { ok: false, content: `${target.path} es una carpeta: usa action=list con ese path.` };
				const text = await extractText(target.full);
				const line = num(args.line);
				// PDF y Word no tienen líneas útiles: se leen por letras. El código y las notas, por líneas.
				const byChars = line === undefined && (num(args.offset) !== undefined || !isTextFile(target.full));
				const s = sliceText(text, {
					line,
					lines: num(args.lines),
					offset: byChars ? Math.max(0, Math.floor(num(args.offset) ?? 0)) : undefined,
					maxChars: currentResultBudget() - 300,
				});
				return { ok: true, content: `Archivo: ${target.path}${s.range}\n\n${s.body}${s.note}` };
			}
			case "search": {
				const query = String(args.query ?? "").trim();
				const files = typeof args.files === "string" && args.files.trim() ? args.files.trim() : undefined;
				const r = await searchProject(p, query, target, { files, context: num(args.context) });
				const note = r.partial
					? `\n\n[Búsqueda parcial: hay demasiados archivos para mirarlos todos. Indica path con una carpeta concreta (p. ej. ${projectSources(p).at(-1)?.label ?? "Carpeta"}/subcarpeta) o files (p. ej. *.ts) para buscar ahí.]`
					: "";
				const where = `${target ? target.path : "el proyecto"}${files ? ` (archivos ${files})` : ""}`;
				if (!r.results.length) {
					return { ok: true, content: `No encontré "${query}" en ${where}. Todas las palabras tienen que estar en la misma línea: prueba con menos palabras o con otras.${note}` };
				}
				const head = r.total ? `${r.more ? "Al menos " : ""}${r.total} ${r.total === 1 ? "coincidencia" : "coincidencias"} en ${r.files} ${r.files === 1 ? "archivo" : "archivos"}${r.more ? " (van las primeras; afina la búsqueda para ver otras)" : ""}:\n` : "";
				return { ok: true, content: head + r.results.join("\n") + note };
			}
			case "edit": {
				const r = editProjectFile(p, pathArg, String(args.old_text ?? ""), String(args.new_text ?? ""), args.replace_all === true);
				const times = r.replaced > 1 ? `${r.replaced} veces, la primera en la línea ${r.line}` : `línea ${r.line}`;
				return { ok: true, content: `Cambiado ${r.path} (${times}): ${r.linesBefore} ${r.linesBefore === 1 ? "línea" : "líneas"} → ${r.linesAfter}.` };
			}
			case "write": {
				const r = writeProjectFile(p, pathArg, String(args.content ?? ""));
				return { ok: true, content: `Guardado ${r.path}.` };
			}
			default:
				return { ok: false, content: `Acción desconocida: ${action}. Usa list, find, search, read, edit o write.` };
		}
	} catch (err) {
		return { ok: false, content: err instanceof Error ? err.message : String(err) };
	}
}
