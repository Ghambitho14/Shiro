/**
 * Proyectos: agrupan chats, tienen instrucciones propias y archivos que Shiro puede leer y buscar.
 * - data/projects/<id>/project.json → nombre, instrucciones, carpetas vinculadas y chats.
 * - data/projects/<id>/files/       → copias de lo que el usuario sube desde la web.
 * Siempre se guardan en este equipo (las carpetas vinculadas son rutas de este PC), sea cual sea Ajustes → Datos.
 *
 * El modelo ve las rutas con un prefijo por origen: "Subidos/…" para las copias y "<carpeta>/…"
 * para cada carpeta vinculada (resolveProjectPath).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { DATA_DIR } from "../../config/config.js";
import { isWithinRoot, normalizeForCompare } from "../tools/paths.js";
import { extractText, isReadableDocument, isTextFile } from "./documents.js";

export type ProjectFolder = { path: string; addedAt: number };

export type Project = {
	id: string;
	name: string;
	description: string;
	instructions: string;
	folders: ProjectFolder[];
	chats: string[];
	createdAt: number;
	updatedAt: number;
};

/** Un origen de archivos del proyecto: la carpeta de subidos o una carpeta vinculada. */
export type ProjectSource = { label: string; root: string; kind: "upload" | "folder"; exists: boolean };

export type ProjectFile = { path: string; size: number; mtime: number };

export const UPLOADS_LABEL = "Subidos";
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;
export const MAX_INSTRUCTIONS = 8000;

/** Carpetas que no se recorren (dependencias, compilados, control de versiones). */
const SKIP_DIRS = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", "out", ".next", ".nuxt", ".venv", "venv", "__pycache__", ".cache", "target", "bin", "obj", ".idea", ".vscode"]);
const MAX_FILES = 2000;
const MAX_DEPTH = 12;

export const projectsDir = () => join(DATA_DIR, "projects");
const isValidId = (id: string) => /^[\w-]{1,64}$/.test(id);
const projectDir = (id: string) => join(projectsDir(), id);
const projectFile = (id: string) => join(projectDir(id), "project.json");
export const uploadsDir = (id: string) => join(projectDir(id), "files");

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function sanitizeProject(raw: unknown, id: string): Project | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const now = Date.now();
	return {
		id,
		name: clip(r.name, MAX_NAME) || "Proyecto",
		description: clip(r.description, MAX_DESCRIPTION),
		instructions: clip(r.instructions, MAX_INSTRUCTIONS),
		folders: Array.isArray(r.folders)
			? r.folders
					.filter((f): f is ProjectFolder => !!f && typeof f === "object" && typeof (f as ProjectFolder).path === "string")
					.map((f) => ({ path: f.path, addedAt: Number(f.addedAt) || now }))
			: [],
		chats: Array.isArray(r.chats) ? [...new Set(r.chats.filter((c): c is string => typeof c === "string" && c.length > 0))] : [],
		createdAt: Number(r.createdAt) || now,
		updatedAt: Number(r.updatedAt) || now,
	};
}

function save(p: Project): Project {
	mkdirSync(projectDir(p.id), { recursive: true });
	writeFileSync(projectFile(p.id), JSON.stringify(p, null, 2), "utf-8");
	return p;
}

// ───────────────────────────── proyectos ─────────────────────────────

export function getProject(id: string): Project | null {
	if (!isValidId(id) || !existsSync(projectFile(id))) return null;
	try {
		return sanitizeProject(JSON.parse(readFileSync(projectFile(id), "utf-8")), id);
	} catch {
		return null;
	}
}

/** Todos los proyectos, el usado más recientemente primero. */
export function listProjects(): Project[] {
	if (!existsSync(projectsDir())) return [];
	return readdirSync(projectsDir(), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => getProject(e.name))
		.filter((p): p is Project => p !== null)
		.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createProject(input: { name?: unknown; description?: unknown; instructions?: unknown }): Project {
	const name = clip(input.name, MAX_NAME);
	if (!name) throw new Error("Ponle un nombre al proyecto.");
	const now = Date.now();
	const p: Project = {
		id: randomUUID(),
		name,
		description: clip(input.description, MAX_DESCRIPTION),
		instructions: clip(input.instructions, MAX_INSTRUCTIONS),
		folders: [],
		chats: [],
		createdAt: now,
		updatedAt: now,
	};
	mkdirSync(uploadsDir(p.id), { recursive: true });
	return save(p);
}

export function updateProject(id: string, patch: { name?: unknown; description?: unknown; instructions?: unknown }): Project | null {
	const p = getProject(id);
	if (!p) return null;
	if (patch.name !== undefined) {
		const name = clip(patch.name, MAX_NAME);
		if (!name) throw new Error("El nombre no puede quedar vacío.");
		p.name = name;
	}
	if (patch.description !== undefined) p.description = clip(patch.description, MAX_DESCRIPTION);
	if (patch.instructions !== undefined) p.instructions = clip(patch.instructions, MAX_INSTRUCTIONS);
	p.updatedAt = Date.now();
	return save(p);
}

/** Borra el proyecto y las copias subidas. Las carpetas vinculadas no se tocan; los chats quedan como chats normales. */
export function deleteProject(id: string): boolean {
	if (!getProject(id)) return false;
	rmSync(projectDir(id), { recursive: true, force: true });
	return true;
}

// ───────────────────────────── carpetas vinculadas ─────────────────────────────

/** Comprueba que una carpeta se pueda vincular. Devuelve la ruta absoluta o lanza un Error en español. */
export function checkFolder(pathArg: string): string {
	const raw = pathArg.trim().replace(/^"(.*)"$/, "$1");
	if (!raw) throw new Error("Escribe la ruta de la carpeta.");
	const full = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()));
	if (!existsSync(full)) throw new Error(`No encuentro la carpeta ${full}.`);
	if (!statSync(full).isDirectory()) throw new Error(`${full} no es una carpeta.`);
	if (parse(full).root === full || normalizeForCompare(full) === normalizeForCompare(homedir())) {
		throw new Error("Esa carpeta es demasiado grande: elige una carpeta concreta (por ejemplo la de tu trabajo o tu programa).");
	}
	// Los datos de Shiro tienen claves y sesiones: nunca dentro de un proyecto. Una carpeta que los
	// contiene (p. ej. la de GitHub con Shiro dentro) sí se puede vincular: la de datos queda oculta.
	if (isWithinRoot(full, DATA_DIR, true)) throw new Error("No se puede vincular la carpeta de datos de Aku.");
	return full;
}

/** true si la ruta está dentro de la carpeta de datos de Shiro (se oculta en las carpetas vinculadas). */
const inDataDir = (full: string) => isWithinRoot(full, DATA_DIR, true);

export function addFolder(id: string, pathArg: string): Project | null {
	const p = getProject(id);
	if (!p) return null;
	const full = checkFolder(pathArg);
	if (p.folders.some((f) => normalizeForCompare(f.path) === normalizeForCompare(full))) throw new Error("Esa carpeta ya está en el proyecto.");
	p.folders.push({ path: full, addedAt: Date.now() });
	p.updatedAt = Date.now();
	return save(p);
}

export function removeFolder(id: string, pathArg: string): Project | null {
	const p = getProject(id);
	if (!p) return null;
	const before = p.folders.length;
	p.folders = p.folders.filter((f) => normalizeForCompare(f.path) !== normalizeForCompare(pathArg));
	if (p.folders.length === before) throw new Error("Esa carpeta no está en el proyecto.");
	p.updatedAt = Date.now();
	return save(p);
}

// ───────────────────────────── carpeta de trabajo (modo Code) ─────────────────────────────

/**
 * El proyecto de una carpeta, para el botón de carpeta del modo Code (como en Claude): el que ya la tenga
 * vinculada o, si no hay, uno nuevo con el nombre de la carpeta. Lanza los mismos errores que checkFolder.
 */
export function projectForFolder(pathArg: string): Project {
	const full = checkFolder(pathArg);
	const key = normalizeForCompare(full);
	const found = listProjects().find((p) => p.folders.some((f) => normalizeForCompare(f.path) === key));
	if (found) return found;
	const p = createProject({ name: basename(full) || full });
	return addFolder(p.id, full)!;
}

export type RecentFolder = { path: string; name: string; projectId: string; exists: boolean };

/** Carpetas vinculadas a proyectos, primero las de los proyectos usados hace menos (menú de carpetas de Code). */
export function recentFolders(limit = 8): RecentFolder[] {
	const out: RecentFolder[] = [];
	const seen = new Set<string>();
	for (const p of listProjects()) {
		for (const f of p.folders) {
			const key = normalizeForCompare(f.path);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ path: f.path, name: basename(f.path) || f.path, projectId: p.id, exists: existsSync(f.path) });
			if (out.length >= limit) return out;
		}
	}
	return out;
}

// ───────────────────────────── archivos subidos ─────────────────────────────

/** Ruta relativa segura para un archivo subido ("informes/2024/a.pdf"), o null si no es válida. */
export function cleanUploadPath(rel: string): string | null {
	const parts = rel
		.replace(/\\/g, "/")
		.split("/")
		.map((s) => s.replace(/[<>:"|?*\u0000-\u001f]/g, "").trim())
		.filter((s) => s && s !== ".");
	if (!parts.length || parts.some((s) => s === ".." || /^\.+$/.test(s))) return null;
	return parts.join("/");
}

export function saveUpload(id: string, rel: string, data: Buffer): string {
	const p = getProject(id);
	if (!p) throw new Error("No encontré el proyecto.");
	const clean = cleanUploadPath(rel);
	if (!clean) throw new Error("Nombre de archivo no válido.");
	const full = resolve(uploadsDir(id), clean);
	if (!isWithinRoot(full, uploadsDir(id))) throw new Error("Nombre de archivo no válido.");
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, data);
	p.updatedAt = Date.now();
	save(p);
	return clean;
}

/** Quita un archivo o carpeta subidos (ruta relativa a la carpeta de subidos). */
export function removeUpload(id: string, rel: string): boolean {
	if (!getProject(id)) return false;
	const clean = cleanUploadPath(rel);
	if (!clean) return false;
	const full = resolve(uploadsDir(id), clean);
	if (!isWithinRoot(full, uploadsDir(id)) || !existsSync(full)) return false;
	rmSync(full, { recursive: true, force: true });
	return true;
}

/** Primer nivel de la carpeta de subidos, para la web: archivos y carpetas (con cuántos archivos tienen). */
export function listUploadsTop(id: string): { name: string; kind: "file" | "folder"; size: number; files: number }[] {
	const root = uploadsDir(id);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.map((e) => {
			const full = join(root, e.name);
			if (e.isDirectory()) {
				const files = walkFiles(full, "", false);
				return { name: e.name, kind: "folder" as const, size: files.reduce((s, f) => s + f.size, 0), files: files.length };
			}
			return { name: e.name, kind: "file" as const, size: statSync(full).size, files: 1 };
		})
		.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
}

// ───────────────────────────── chats ─────────────────────────────

/** Proyecto al que pertenece un chat, si alguno. */
export function projectOfChat(chatId: string | undefined): Project | null {
	if (!chatId) return null;
	return listProjects().find((p) => p.chats.includes(chatId)) ?? null;
}

/** Mete un chat en un proyecto (y lo saca del que estuviera). */
export function attachChat(id: string, chatId: string): Project | null {
	const p = getProject(id);
	if (!p || !chatId) return null;
	forgetChat(chatId, id);
	if (!p.chats.includes(chatId)) p.chats.unshift(chatId);
	p.updatedAt = Date.now();
	return save(p);
}

export function detachChat(id: string, chatId: string): Project | null {
	const p = getProject(id);
	if (!p) return null;
	p.chats = p.chats.filter((c) => c !== chatId);
	return save(p);
}

/** Olvida un chat (al borrarlo) en todos los proyectos, salvo `except`. */
export function forgetChat(chatId: string, except?: string): void {
	for (const p of listProjects()) {
		if (p.id === except || !p.chats.includes(chatId)) continue;
		p.chats = p.chats.filter((c) => c !== chatId);
		save(p);
	}
}

/** Marca el proyecto como usado ahora (para ordenarlo arriba en la barra lateral). */
export function touchProject(id: string): void {
	const p = getProject(id);
	if (p) save({ ...p, updatedAt: Date.now() });
}

// ───────────────────────────── archivos para el modelo ─────────────────────────────

/** Orígenes de archivos del proyecto, con nombres únicos. */
export function projectSources(p: Project): ProjectSource[] {
	const sources: ProjectSource[] = [{ label: UPLOADS_LABEL, root: uploadsDir(p.id), kind: "upload", exists: true }];
	const used = new Set([UPLOADS_LABEL.toLowerCase()]);
	for (const f of p.folders) {
		const base = basename(f.path) || "Carpeta";
		let label = base;
		for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`;
		used.add(label.toLowerCase());
		sources.push({ label, root: f.path, kind: "folder", exists: existsSync(f.path) });
	}
	return sources;
}

export type ResolvedPath = { source: ProjectSource; full: string; path: string };

/**
 * Ruta del modelo ("Subidos/a.pdf", "MiCarpeta/src/x.ts" o una ruta absoluta dentro de una carpeta
 * del proyecto) → ruta real. null si se sale del proyecto.
 */
export function resolveProjectPath(p: Project, pathArg: string): ResolvedPath | null {
	const raw = pathArg.trim().replace(/\\/g, "/");
	const sources = projectSources(p);
	if (/^([A-Za-z]:\/|\/)/.test(raw)) {
		const full = resolve(raw);
		const source = sources.find((s) => isWithinRoot(full, s.root, true));
		if (!source || (source.kind === "folder" && inDataDir(full))) return null;
		const rel = full.slice(resolve(source.root).length).replace(/\\/g, "/").replace(/^\/+/, "");
		return { source, full, path: rel ? `${source.label}/${rel}` : source.label };
	}
	const clean = raw.replace(/^\.?\/+/, "").replace(/\/+/g, "/");
	const [first, ...rest] = clean.split("/");
	const source = sources.find((s) => s.label.toLowerCase() === (first ?? "").toLowerCase());
	if (!source) return null;
	const relPath = rest.join("/");
	const full = resolve(source.root, relPath || ".");
	if (!isWithinRoot(full, source.root, true) || (source.kind === "folder" && inDataDir(full))) return null;
	const rel = full.slice(resolve(source.root).length).replace(/\\/g, "/").replace(/^\/+/, "");
	return { source, full, path: rel ? `${source.label}/${rel}` : source.label };
}

/**
 * Recorre una carpeta. En las vinculadas (`linked`) se saltan dependencias, compilados y la carpeta de
 * datos de Shiro; en lo subido, solo los ocultos.
 */
function walkFiles(root: string, prefix: string, linked = true, out: ProjectFile[] = [], limit = MAX_FILES, depth = 0): ProjectFile[] {
	if (depth > MAX_DEPTH || out.length >= limit) return out;
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const e of entries) {
		if (out.length >= limit) break;
		if (e.name.startsWith(".") || (linked && e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
		const full = join(root, e.name);
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!linked || !inDataDir(full)) walkFiles(full, rel, linked, out, limit, depth + 1);
		}
		else if (e.isFile()) {
			try {
				const st = statSync(full);
				out.push({ path: rel, size: st.size, mtime: st.mtimeMs });
			} catch {
				// Archivo que desapareció o sin permiso: se omite.
			}
		}
	}
	return out;
}

/** Archivos del proyecto (rutas con prefijo de origen), como mucho `limit`. Con `under`, solo los de esa carpeta. */
export function listProjectFiles(p: Project, under?: ResolvedPath, limit = MAX_FILES): ProjectFile[] {
	if (under) {
		if (!existsSync(under.full)) return [];
		if (statSync(under.full).isFile()) {
			const st = statSync(under.full);
			return [{ path: under.path, size: st.size, mtime: st.mtimeMs }];
		}
		return walkFiles(under.full, under.path, under.source.kind === "folder", [], limit);
	}
	const out: ProjectFile[] = [];
	for (const s of projectSources(p)) {
		if (!s.exists || out.length >= limit) continue;
		walkFiles(s.root, s.label, s.kind === "folder", out, limit);
	}
	return out;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Lista corta de archivos para el system prompt. */
export function projectIndex(p: Project, maxChars = 1500): string {
	const missing = projectSources(p).filter((s) => !s.exists).map((s) => `- ${s.label}/ (la carpeta ${s.root} ya no existe)`);
	const files = listProjectFiles(p);
	if (!files.length && !missing.length) return "(El proyecto aún no tiene archivos.)";
	// Carpetas grandes (p. ej. GitHub con muchos programas): mejor sus carpetas principales que los primeros archivos.
	if (files.reduce((n, f) => n + f.path.length + 12, 0) > maxChars) return projectOutline(p, files.length, maxChars, missing);
	const lines: string[] = [...missing];
	let used = missing.join("\n").length;
	for (const [i, f] of files.entries()) {
		const line = `- ${f.path} (${formatSize(f.size)})`;
		if (used + line.length > maxChars) {
			lines.push(`- …y ${files.length - i} archivos más (usa project con action=list para verlos).`);
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	return lines.join("\n");
}

/** Primer nivel de cada carpeta del proyecto, para el prompt cuando hay demasiados archivos para listarlos. */
function projectOutline(p: Project, total: number, maxChars: number, missing: string[]): string {
	const lines = [`(${total >= MAX_FILES ? `Más de ${MAX_FILES}` : total} archivos: estas son sus carpetas principales. Usa project con action=list y path para ver dentro.)`, ...missing];
	let used = lines.join("\n").length;
	for (const s of projectSources(p)) {
		if (!s.exists) continue;
		let entries;
		try {
			entries = readdirSync(s.root, { withFileTypes: true });
		} catch {
			continue;
		}
		const items = entries
			.filter((e) => !e.name.startsWith(".") && !(s.kind === "folder" && e.isDirectory() && (SKIP_DIRS.has(e.name) || inDataDir(join(s.root, e.name)))))
			.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
		for (const [i, e] of items.entries()) {
			const line = `- ${s.label}/${e.name}${e.isDirectory() ? "/" : ""}`;
			if (used + line.length > maxChars) {
				lines.push(`- …y ${items.length - i} más en ${s.label}/`);
				break;
			}
			lines.push(line);
			used += line.length + 1;
		}
	}
	return lines.join("\n");
}

/**
 * Si el proyecto es pequeño (pocos archivos y poco texto), su contenido completo para el prompt;
 * si no, null (el modelo lo lee con la tool project).
 */
export async function inlineProjectText(p: Project, maxChars = 4000): Promise<string | null> {
	const files = listProjectFiles(p).filter((f) => isReadableDocument(f.path));
	if (!files.length || files.length > 8 || files.reduce((s, f) => s + f.size, 0) > 2 * 1024 * 1024) return null;
	let out = "";
	for (const f of files) {
		const r = resolveProjectPath(p, f.path);
		if (!r) continue;
		let text: string;
		try {
			text = await extractText(r.full);
		} catch {
			continue;
		}
		out += `### ${f.path}\n${text.trim()}\n\n`;
		if (out.length > maxChars) return null;
	}
	return out.trim() || null;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Un patrón con comodines (`*.test.ts`, `src/**\/api*`) como expresión regular: `*` no cruza carpetas, `**` sí. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
				if (glob[i + 1] === "/") i++;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/**
 * ¿Coincide la ruta de un archivo con lo que se busca? Con comodines es un patrón (sin `/`, solo
 * sobre el nombre del archivo); sin comodines, todas las palabras tienen que estar en la ruta.
 */
export function fileMatcher(pattern: string): (path: string) => boolean {
	const clean = pattern.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "");
	if (/[*?]/.test(clean)) {
		const re = globToRegExp(clean);
		if (!clean.includes("/")) return (path) => re.test(path.slice(path.lastIndexOf("/") + 1));
		// El modelo puede escribir la ruta con o sin el nombre de la carpeta del proyecto delante.
		return (path) => re.test(path) || re.test(path.slice(path.indexOf("/") + 1));
	}
	const words = fold(clean).split(/\s+/).filter(Boolean);
	return (path) => {
		const folded = fold(path);
		return words.length > 0 && words.every((w) => folded.includes(w));
	};
}

/** Archivos que se recorren como mucho al buscar por nombre. */
const FIND_MAX_FILES = 20_000;

/** Archivos del proyecto cuyo nombre o ruta coincide con `query` (palabras o patrón con comodines). */
export function findProjectFiles(p: Project, query: string, under?: ResolvedPath, max = 100): { files: ProjectFile[]; total: number; partial: boolean } {
	const all = listProjectFiles(p, under, FIND_MAX_FILES);
	const matches = all.filter((f) => fileMatcher(query)(f.path));
	return { files: matches.slice(0, max), total: matches.length, partial: all.length >= FIND_MAX_FILES };
}

/** Límites de una búsqueda: archivos que se miran y tiempo máximo (carpetas enormes como la de GitHub). */
const SEARCH_MAX_FILES = 3000;
const SEARCH_MAX_MS = 8000;
/** Con la lista de resultados ya llena, se sigue contando solo este rato. */
const SEARCH_COUNT_MS = 1500;

/** Archivos que la búsqueda lee: texto de hasta 1 MB, PDF y Word de hasta 5 MB. */
const searchable = (f: ProjectFile) => isReadableDocument(f.path) && f.size <= (isTextFile(f.path) ? 1 : 5) * 1024 * 1024;

export type SearchOptions = {
	/** Líneas que se devuelven en total. */
	maxResults?: number;
	/** Solo en los archivos que coinciden (`*.ts`, `src/**`). */
	files?: string;
	/** Líneas de alrededor que se enseñan con cada coincidencia (0 a 3). */
	context?: number;
	/** Líneas por archivo: así los resultados no se quedan todos en los primeros archivos. */
	perFile?: number;
};

export type SearchResult = {
	results: string[];
	/** No dio tiempo a mirar todos los archivos (conviene buscar en una carpeta concreta). */
	partial: boolean;
	/** Líneas que coinciden y en cuántos archivos (si `more`, al menos esas). */
	total: number;
	files: number;
	more: boolean;
};

/**
 * Busca texto en los archivos del proyecto: líneas que contienen todas las palabras (con «|», las de alguna alternativa).
 * Es por palabras, sin expresiones regulares: una mal escrita podría colgar el servidor.
 */
export async function searchProject(p: Project, query: string, under?: ResolvedPath, opts: SearchOptions = {}): Promise<SearchResult> {
	const maxResults = opts.maxResults ?? 40;
	const perFile = opts.perFile ?? 5;
	const context = Math.max(0, Math.min(3, Math.floor(opts.context ?? 0)));
	// Los modelos escriben a menudo «a|b» o «a.*b» por costumbre: «|» separa alternativas y «.*» es «y».
	const alternatives = query
		.split("|")
		.map((alt) => fold(alt.replace(/\.[*+]\??/g, " ")).split(/\s+/).filter((w) => w.length > 1))
		.filter((alt) => alt.length > 0);
	const hits = (text: string) => alternatives.some((alt) => alt.every((w) => text.includes(w)));
	const out: SearchResult = { results: [], partial: false, total: 0, files: 0, more: false };
	if (!alternatives.length) return out;
	const all = listProjectFiles(p, under, SEARCH_MAX_FILES * 3);
	const matches = opts.files ? fileMatcher(opts.files) : null;
	const candidates = all.filter((f) => searchable(f) && (!matches || matches(f.path)));
	const files = candidates.slice(0, SEARCH_MAX_FILES);
	out.partial = all.length >= SEARCH_MAX_FILES * 3 || candidates.length > files.length;
	const started = Date.now();
	let shown = 0;
	for (const f of files) {
		const elapsed = Date.now() - started;
		if (elapsed > SEARCH_MAX_MS) {
			out.partial = true;
			break;
		}
		if (shown >= maxResults && elapsed > SEARCH_COUNT_MS) {
			out.more = true;
			break;
		}
		const r = resolveProjectPath(p, f.path);
		if (!r) continue;
		let text: string;
		try {
			text = await extractText(r.full);
		} catch {
			continue;
		}
		if (shown < maxResults && hits(fold(f.path))) out.results.push(`${f.path}: (el nombre del archivo coincide)`);
		const lines = text.split(/\r?\n/);
		let inFile = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = fold(lines[i]!);
			if (!hits(line)) continue;
			inFile++;
			if (inFile > perFile || shown >= maxResults) continue;
			shown++;
			const snippet = lines[i]!.trim();
			out.results.push(`${f.path}:${i + 1}: ${snippet.length > 200 ? snippet.slice(0, 197) + "…" : snippet}`);
			for (let j = Math.max(0, i - context); context && j <= Math.min(lines.length - 1, i + context); j++) {
				if (j === i || !lines[j]!.trim()) continue;
				const near = lines[j]!.trimEnd();
				out.results.push(`    ${j + 1}| ${near.length > 200 ? near.slice(0, 197) + "…" : near}`);
			}
		}
		if (!inFile) continue;
		out.total += inFile;
		out.files++;
		const hidden = inFile - Math.min(inFile, perFile);
		if (hidden > 0 && shown <= maxResults) out.results.push(`${f.path}: (+${hidden} coincidencias más en este archivo)`);
	}
	if (out.total > shown) out.more = out.more || shown >= maxResults;
	return out;
}

/** Escribe un archivo de texto dentro del proyecto (la aprobación la pide el registro de tools). */
export function writeProjectFile(p: Project, pathArg: string, content: string): ResolvedPath {
	const r = resolveProjectPath(p, pathArg);
	if (!r || r.full === resolve(r.source.root)) throw new Error(`La ruta ${pathArg} no está dentro del proyecto. Empieza por el nombre de una de sus carpetas (${projectSources(p).map((s) => s.label + "/").join(", ")}).`);
	if (!r.source.exists) throw new Error(`La carpeta ${r.source.root} ya no existe.`);
	if (!isTextFile(r.full)) throw new Error("Solo puedo escribir archivos de texto (.txt, .md, .csv, código…), no PDF ni Word.");
	mkdirSync(dirname(r.full), { recursive: true });
	writeFileSync(r.full, content, "utf-8");
	return r;
}

export type EditResult = { path: string; line: number; replaced: number; linesBefore: number; linesAfter: number };

/** Archivos que se editan por trozos como mucho. */
const EDIT_MAX_BYTES = 2 * 1024 * 1024;

const countLines = (s: string) => (s ? s.split("\n").length : 0);
const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Dónde empieza cada aparición de `needle` (sin solaparse). */
function occurrences(text: string, needle: string): number[] {
	const out: number[] = [];
	for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) out.push(i);
	return out;
}

/**
 * Cambia un trozo de un archivo de texto del proyecto: `oldText` tiene que estar tal cual y una sola
 * vez (o todas, con `replaceAll`). Así no hay que reescribir el archivo entero para tocar una línea.
 * Conserva los saltos de línea del archivo (Windows o Unix). La aprobación la pide el registro de tools.
 */
export function editProjectFile(p: Project, pathArg: string, oldText: string, newText: string, replaceAll = false): EditResult {
	const r = resolveProjectPath(p, pathArg);
	if (!r || r.full === resolve(r.source.root)) throw new Error(`La ruta ${pathArg} no está dentro del proyecto. Empieza por el nombre de una de sus carpetas (${projectSources(p).map((s) => s.label + "/").join(", ")}).`);
	if (!existsSync(r.full) || !statSync(r.full).isFile()) throw new Error(`No existe ${r.path}. Para crear un archivo nuevo usa action=write.`);
	if (!isTextFile(r.full)) throw new Error("Solo puedo editar archivos de texto (.txt, .md, .csv, código…), no PDF ni Word.");
	if (statSync(r.full).size > EDIT_MAX_BYTES) throw new Error("El archivo es demasiado grande para editarlo (máx. 2 MB).");

	const raw = readFileSync(r.full, "utf-8");
	const bom = raw.startsWith("﻿") ? "﻿" : "";
	const crlf = raw.includes("\r\n");
	const unix = (s: string) => s.replace(/\r\n/g, "\n");
	const text = unix(bom ? raw.slice(1) : raw);
	const from = unix(oldText);
	const to = unix(newText);
	if (!from) throw new Error("Indica en old_text el trozo exacto que hay ahora en el archivo.");
	if (from === to) throw new Error("old_text y new_text son iguales: no hay nada que cambiar.");

	// Trozos a cambiar: [inicio, fin) en `text`.
	let spans = occurrences(text, from).map((i): [number, number] => [i, i + from.length]);
	if (!spans.length) {
		// Segunda oportunidad: los modelos suelen perder los espacios del final de las líneas.
		const trim = (s: string) => s.split("\n").map((l) => l.trimEnd());
		const lines = text.split("\n");
		const trimmed = lines.map((l) => l.trimEnd());
		const starts: number[] = [];
		for (let i = 0, at = 0; i < lines.length; i++) {
			starts.push(at);
			at += lines[i]!.length + 1;
		}
		const joined = trimmed.join("\n");
		const needle = trim(from).join("\n");
		// De una posición en el texto sin espacios finales a la misma posición en el original.
		const real = (index: number) => {
			const before = joined.slice(0, index).split("\n");
			return starts[before.length - 1]! + before[before.length - 1]!.length;
		};
		if (needle.trim()) spans = occurrences(joined, needle).map((i): [number, number] => [real(i), real(i + needle.length)]);
	}
	if (!spans.length) {
		const first = from.split("\n").find((l) => l.trim())?.trim() ?? "";
		const at = first ? text.split("\n").findIndex((l) => l.includes(first)) : -1;
		const hint = at >= 0 ? ` Su primera línea aparece en la línea ${at + 1}: lee ese tramo con action=read (line=${Math.max(1, at - 2)}) y copia el trozo tal cual.` : " Lee esa parte con action=read y copia el trozo tal cual, con sus espacios.";
		throw new Error(`No encontré ese texto en ${r.path}.${hint}`);
	}
	if (spans.length > 1 && !replaceAll) {
		const where = spans.slice(0, 6).map(([i]) => lineOf(text, i)).join(", ");
		throw new Error(`Ese texto aparece ${spans.length} veces en ${r.path} (líneas ${where}). Añade a old_text más líneas de alrededor para que sea único, o usa replace_all=true para cambiarlas todas.`);
	}

	let result = text;
	for (const [start, end] of [...spans].reverse()) result = result.slice(0, start) + to + result.slice(end);
	writeFileSync(r.full, bom + (crlf ? result.replace(/\n/g, "\r\n") : result), "utf-8");
	return { path: r.path, line: lineOf(text, spans[0]![0]), replaced: spans.length, linesBefore: countLines(from), linesAfter: countLines(to) };
}

// ───────────────────────────── proyecto activo ─────────────────────────────

const activeProject = new AsyncLocalStorage<Project | undefined>();

/** Ejecuta fn con este proyecto como el del chat actual (lo usa la tool project). */
export function runWithProject<T>(project: Project | undefined, fn: () => Promise<T>): Promise<T> {
	return activeProject.run(project, fn);
}

export function currentProject(): Project | undefined {
	return activeProject.getStore();
}
