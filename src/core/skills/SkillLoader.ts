/**
 * Habilidades (skills): carpetas con un SKILL.md (formato de Claude Code, Codex, OpenCode…).
 *
 * - Las de Shiro viven en data/workspace/skills/<nombre>/SKILL.md y se crean desde Ajustes.
 * - Las de otras aplicaciones (~/.claude/skills, ~/.codex/skills…) se detectan y se usan solas; el usuario
 *   puede apagar una aplicación entera o una habilidad suelta. Las que vienen incluidas con la propia app
 *   (p. ej. ~/.codex/skills/.system) empiezan apagadas: suelen depender de herramientas de esa app.
 *
 * Al modelo solo se le da la lista (nombre + descripción) en el system prompt; el contenido
 * completo lo carga él mismo con la tool use_skill cuando una encaja. Así no se gasta contexto.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getConfig } from "../../config/config.js";
import { LOCAL_WORKSPACE_DIR } from "../../workspace.js";

export const SHIRO_SKILLS_DIR = join(LOCAL_WORKSPACE_DIR, "skills");

/**
 * Aplicaciones cuyas habilidades se usan (carpeta relativa a la carpeta del usuario).
 * builtIn: subcarpetas que gestiona la propia app (copias de claude.ai, las de sistema de Codex):
 * se muestran, pero empiezan apagadas porque suelen pedir herramientas que Shiro no tiene.
 */
export const EXTERNAL_SKILL_SOURCES: ReadonlyArray<{ id: string; label: string; dir: readonly string[]; builtIn?: readonly string[] }> = [
	{ id: "claude", label: "Claude Code", dir: [".claude", "skills"], builtIn: ["synced"] },
	{ id: "agents", label: "Otros agentes", dir: [".agents", "skills"] },
	{ id: "codex", label: "Codex", dir: [".codex", "skills"], builtIn: [".system"] },
	{ id: "copilot", label: "GitHub Copilot", dir: [".copilot", "skills"] },
	{ id: "opencode", label: "OpenCode", dir: [".config", "opencode", "skills"] },
	{ id: "lmstudio", label: "LM Studio", dir: [".lmstudio", "skills"] },
];

export type Skill = {
	/** Único: "<origen>:<carpeta relativa>". Es lo que se guarda en disabledSkills. */
	id: string;
	/** "shiro", el id de la aplicación, o "path:<n>" para carpetas añadidas a mano. */
	source: string;
	name: string;
	description: string;
	dir: string;
	file: string;
	enabled: boolean;
	/** Incluida con la aplicación (no instalada por el usuario): apagada hasta que se encienda. */
	builtIn: boolean;
};

export type SkillGroup = {
	source: string;
	label: string;
	dir: string;
	exists: boolean;
	/** Si el grupo entero está activado (las de Shiro y las carpetas propias, siempre). */
	enabled: boolean;
	skills: Skill[];
};

const MAX_DEPTH = 3;
const MAX_SKILLS_PER_ROOT = 300;
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__"]);
/** Carpetas ocultas en las que sí se buscan habilidades (Codex guarda ahí las suyas). */
const ALLOWED_DOT_DIRS = new Set([".system"]);
const MAX_FILE_BYTES = 256 * 1024;

// ───────────────────────────── SKILL.md ─────────────────────────────

/**
 * Separa el encabezado YAML (--- ... ---) del cuerpo. Solo entiende lo que usan los SKILL.md:
 * `clave: valor`, valores entre comillas y bloques `>` / `|` con líneas sangradas.
 */
export function parseSkillMarkdown(text: string): { meta: Record<string, string>; body: string; rawMeta: string } {
	const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
	const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
	if (!m) return { meta: {}, body: src.trim(), rawMeta: "" };
	const meta: Record<string, string> = {};
	const lines = m[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
		if (!kv) continue;
		const key = kv[1];
		let value = kv[2].trim();
		if (/^[>|][+-]?$/.test(value)) {
			const folded = value.startsWith(">");
			const block: string[] = [];
			while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
			value = block.join(folded ? " " : "\n").replace(/\s+$/, "");
		} else if (/^"(.*)"$/.test(value)) {
			try {
				value = JSON.parse(value) as string;
			} catch {
				value = value.slice(1, -1);
			}
		} else if (/^'(.*)'$/.test(value)) {
			value = value.slice(1, -1).replace(/''/g, "'");
		}
		meta[key] = value;
	}
	return { meta, body: src.slice(m[0].length).trim(), rawMeta: m[1] };
}

/** Nombre de carpeta válido para una habilidad: minúsculas, números y guiones. */
export function skillSlug(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function buildSkillMarkdown(name: string, description: string, body: string, extraMeta = ""): string {
	const oneLine = description.replace(/\s+/g, " ").trim();
	const extra = extraMeta.trim() ? `${extraMeta.trim()}\n` : "";
	// JSON.stringify da una cadena con comillas dobles que YAML también entiende.
	return `---\nname: ${name}\ndescription: ${JSON.stringify(oneLine)}\n${extra}---\n\n${body.trim()}\n`;
}

/** Quita name/description del encabezado original para conservar el resto al editar. */
function extraMetaLines(rawMeta: string): string {
	const out: string[] = [];
	let skipping = false;
	for (const line of rawMeta.split("\n")) {
		if (/^(name|description):/.test(line)) {
			skipping = true;
			continue;
		}
		if (skipping && (/^\s+\S/.test(line) || line.trim() === "")) continue;
		skipping = false;
		out.push(line);
	}
	return out.join("\n");
}

// ───────────────────────────── búsqueda en disco ─────────────────────────────

/** Carpetas (hasta 3 niveles) que contienen un SKILL.md. No se entra dentro de una habilidad. */
export function findSkillDirs(root: string, maxDepth = MAX_DEPTH): string[] {
	const found: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (found.length >= MAX_SKILLS_PER_ROOT) return;
		if (depth > 0 && existsSync(join(dir, "SKILL.md"))) {
			found.push(dir);
			return;
		}
		if (depth >= maxDepth) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
			if (e.name.startsWith(".") && !ALLOWED_DOT_DIRS.has(e.name)) continue;
			walk(join(dir, e.name), depth + 1);
		}
	};
	try {
		if (statSync(root).isDirectory()) walk(resolve(root), 0);
	} catch {
		// la carpeta no existe
	}
	return found;
}

type Switches = { disabled: Set<string>; enabled: Set<string> };

function readSkillAt(dir: string, root: string, source: string, sw: Switches, groupEnabled: boolean, builtInDirs: readonly string[]): Skill | null {
	const file = join(dir, "SKILL.md");
	try {
		if (statSync(file).size > MAX_FILE_BYTES) return null;
		const { meta, body } = parseSkillMarkdown(readFileSync(file, "utf-8"));
		const folder = relative(root, dir).split(sep).join("/");
		const name = (meta.name || dir.split(/[\\/]/).pop() || "habilidad").trim().slice(0, 80);
		const description = (meta.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "").trim();
		const id = `${source}:${folder}`;
		const builtIn = builtInDirs.some((d) => folder.startsWith(`${d}/`));
		const on = builtIn ? sw.enabled.has(id) : !sw.disabled.has(id);
		return { id, source, name, description, dir, file, enabled: groupEnabled && on, builtIn };
	} catch {
		return null;
	}
}

function scanGroup(source: string, label: string, root: string, groupEnabled: boolean, sw: Switches, builtInDirs: readonly string[] = []): SkillGroup {
	const exists = existsSync(root);
	const seen = new Set<string>();
	const skills: Skill[] = [];
	if (exists) {
		for (const dir of findSkillDirs(root)) {
			const skill = readSkillAt(dir, root, source, sw, groupEnabled, builtInDirs);
			// La misma habilidad copiada dos veces en la carpeta (p. ej. de dos cuentas): se enseña una.
			if (!skill || seen.has(skill.name.toLowerCase())) continue;
			seen.add(skill.name.toLowerCase());
			skills.push(skill);
		}
		// Primero las que instaló el usuario; después las que trae la app.
		skills.sort((a, b) => Number(a.builtIn) - Number(b.builtIn));
	}
	return { source, label, dir: root, exists, enabled: groupEnabled && exists, skills };
}

export function externalSourceDir(id: string, home = homedir()): string | undefined {
	const src = EXTERNAL_SKILL_SOURCES.find((s) => s.id === id);
	return src ? join(home, ...src.dir) : undefined;
}

// Leer todas las carpetas en cada mensaje sería lento: se recuerda unos segundos.
const CACHE_MS = 3000;
let cache: { key: string; at: number; groups: SkillGroup[] } | null = null;

/** Olvida lo leído del disco (tras crear, editar o borrar una habilidad). */
export function clearSkillCache(): void {
	cache = null;
}

/**
 * Todas las habilidades, agrupadas por origen (para la pantalla de Ajustes).
 * Con onlyEnabled no se leen las carpetas de las aplicaciones apagadas.
 */
export function listSkillGroups(onlyEnabled = false): SkillGroup[] {
	const cfg = getConfig();
	const key = JSON.stringify([onlyEnabled, homedir(), cfg.disabledSkills, cfg.enabledSkills, cfg.disabledSkillSources, cfg.skillPaths]);
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.groups;

	const sw: Switches = { disabled: new Set(cfg.disabledSkills), enabled: new Set(cfg.enabledSkills) };
	const off = new Set(cfg.disabledSkillSources);
	const groups: SkillGroup[] = [scanGroup("shiro", "Shiro", SHIRO_SKILLS_DIR, true, sw)];
	cfg.skillPaths.forEach((p, i) => groups.push(scanGroup(`path:${i}`, p, resolve(p), true, sw)));
	for (const src of EXTERNAL_SKILL_SOURCES) {
		if (onlyEnabled && off.has(src.id)) continue;
		groups.push(scanGroup(src.id, src.label, externalSourceDir(src.id)!, !off.has(src.id), sw, src.builtIn));
	}
	cache = { key, at: Date.now(), groups };
	return groups;
}

/** Habilidades que puede usar el modelo. Si dos se llaman igual, gana la primera (Shiro > carpetas > apps). */
export function getEnabledSkills(): Skill[] {
	const seen = new Set<string>();
	const out: Skill[] = [];
	for (const g of listSkillGroups(true)) {
		for (const s of g.skills) {
			const key = s.name.toLowerCase();
			if (!s.enabled || seen.has(key)) continue;
			seen.add(key);
			out.push(s);
		}
	}
	return out;
}

export function findSkillById(id: string): Skill | undefined {
	for (const g of listSkillGroups()) {
		const s = g.skills.find((x) => x.id === id);
		if (s) return s;
	}
	return undefined;
}

// ───────────────────────────── para el modelo ─────────────────────────────

const STOPWORDS = new Set([
	"este", "esta", "esto", "estos", "para", "como", "cómo", "pero", "porque", "favor", "hola", "gracias", "quiero", "puedes",
	"hazme", "dame", "sobre", "with", "this", "that", "from", "your", "when", "what", "have", "will", "about", "please",
]);

/** Palabras "raíz" (5 primeras letras, sin tildes): así "resume" encaja con "resumir" y "correo" con "correos". */
function stems(text: string): string[] {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.split(/[^a-z0-9ñ]+/)
		.filter((t) => t.length >= 4 && !STOPWORDS.has(t))
		.map((t) => t.slice(0, 5));
}

function relevance(goalStems: Set<string>, s: Skill): number {
	if (goalStems.size === 0) return 0;
	const words = new Set(stems(`${s.name} ${s.description}`));
	let score = 0;
	for (const stem of goalStems) if (words.has(stem)) score += 2;
	return score;
}

function clip(s: string, max: number): string {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/**
 * Lista de habilidades para el system prompt, las más relacionadas con el mensaje primero.
 * Vacío si no hay ninguna activa.
 */
export function buildSkillsBlock(goal: string, maxChars?: number, skills = getEnabledSkills()): string {
	if (skills.length === 0) return "";
	const budget = maxChars && maxChars > 0 ? maxChars : getConfig().skillsMaxChars;
	const goalStems = new Set(stems(goal).slice(0, 40));
	const ranked = skills
		.map((s) => ({ s, score: relevance(goalStems, s) }))
		.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));

	// Si una destaca claramente, se le dice al modelo: los modelos pequeños casi nunca la cargan solos.
	const [best, second] = ranked;
	const hint =
		best && best.score >= 4 && best.score > (second?.score ?? 0)
			? `\nPara este mensaje parece útil la habilidad "${best.s.name}": cárgala con use_skill antes de responder.`
			: "";
	const head = `## Habilidades\nTienes habilidades con instrucciones especializadas. Si una encaja con lo que pide el usuario, cárgala con use_skill (name) antes de responder y sigue sus instrucciones.${hint}`;
	let used = head.length;
	const lines: string[] = [];
	for (const { s } of ranked) {
		const line = `- ${s.name}: ${clip(s.description, 180)}`;
		if (used + line.length + 1 > budget - 80) break;
		lines.push(line);
		used += line.length + 1;
	}
	const rest = skills.length - lines.length;
	const more = rest > 0 ? `\n(Hay ${rest} más: llama a use_skill sin name para ver la lista completa.)` : "";
	return `${head}\n${lines.join("\n")}${more}`;
}

function findEnabledSkill(name: string): Skill | undefined {
	const q = name.trim().toLowerCase();
	const skills = getEnabledSkills();
	return skills.find((s) => s.name.toLowerCase() === q || s.id.toLowerCase() === q) ?? skills.find((s) => skillSlug(s.name) === skillSlug(q));
}

/** Archivos de la habilidad (rutas relativas), para que el modelo sepa qué más puede leer. */
function listSkillFiles(dir: string, max = 40): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (out.length >= max) return;
			if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
			const full = join(d, e.name);
			if (e.isDirectory()) {
				if (depth < 2) walk(full, depth + 1);
			} else if (e.name !== "SKILL.md") {
				out.push(relative(dir, full).split(sep).join("/"));
			}
		}
	};
	walk(dir, 0);
	return out;
}

/** Ruta de un archivo dentro de la carpeta de la habilidad, o null si se sale de ella. */
export function resolveInsideSkill(dir: string, file: string): string | null {
	if (!file.trim() || isAbsolute(file)) return null;
	const full = resolve(dir, file);
	const rel = relative(dir, full);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	try {
		// Un enlace simbólico podría apuntar fuera de la carpeta.
		const realDir = realpathSync(dir);
		const realFull = realpathSync(full);
		if (realFull !== realDir && !realFull.startsWith(realDir + sep)) return null;
		return statSync(realFull).isFile() ? realFull : null;
	} catch {
		return null;
	}
}

/** Lo que devuelve la tool use_skill. */
export function useSkill(name?: string, file?: string): { ok: boolean; content: string } {
	const skills = getEnabledSkills();
	if (!name?.trim()) {
		if (!skills.length) return { ok: false, content: "No hay habilidades activadas. El usuario puede añadirlas en Ajustes → Habilidades." };
		return { ok: true, content: `Habilidades disponibles (${skills.length}):\n${skills.map((s) => `- ${s.name}: ${clip(s.description, 240)}`).join("\n")}` };
	}
	const skill = findEnabledSkill(name);
	if (!skill) {
		return { ok: false, content: `No existe la habilidad "${name}". Disponibles: ${skills.map((s) => s.name).join(", ") || "ninguna"}.` };
	}
	if (file?.trim()) {
		const path = resolveInsideSkill(skill.dir, file.trim());
		if (!path) return { ok: false, content: `El archivo "${file}" no existe dentro de la habilidad ${skill.name}.` };
		if (statSync(path).size > MAX_FILE_BYTES) return { ok: false, content: `El archivo "${file}" es demasiado grande para leerlo.` };
		return { ok: true, content: `# ${skill.name} / ${file}\n\n${readFileSync(path, "utf-8")}` };
	}
	const { body } = parseSkillMarkdown(readFileSync(skill.file, "utf-8"));
	const files = listSkillFiles(skill.dir);
	const extra = files.length
		? `\n\n---\nCarpeta de la habilidad: ${skill.dir}\nOtros archivos (léelos con use_skill y file si las instrucciones lo piden):\n${files.map((f) => `- ${f}`).join("\n")}`
		: "";
	return { ok: true, content: `# Habilidad: ${skill.name}\n\n${body}${extra}` };
}

/** Contenido completo de una habilidad para forzarla con "/nombre" en el chat. */
export function getSkillInstructions(name: string): { name: string; body: string } | null {
	const skill = findEnabledSkill(name);
	if (!skill) return null;
	try {
		return { name: skill.name, body: parseSkillMarkdown(readFileSync(skill.file, "utf-8")).body };
	} catch {
		return null;
	}
}

// ───────────────────────────── habilidades propias de Shiro ─────────────────────────────

export function readSkillDetails(id: string): { skill: Skill; description: string; body: string; editable: boolean } | null {
	const skill = findSkillById(id);
	if (!skill) return null;
	const { meta, body } = parseSkillMarkdown(readFileSync(skill.file, "utf-8"));
	return { skill, description: meta.description ?? skill.description, body, editable: skill.source === "shiro" };
}

/**
 * Crea o actualiza una habilidad de Shiro. Si cambia el nombre, se mueve a su nueva carpeta.
 * Devuelve el id nuevo.
 */
export function saveOwnSkill(input: { name: string; description: string; instructions: string; originalId?: string }): string {
	const slug = skillSlug(input.name);
	if (!slug) throw new Error("Ponle un nombre a la habilidad (letras o números).");
	if (!input.description.trim()) throw new Error("Escribe una descripción: el modelo la usa para saber cuándo usarla.");
	if (!input.instructions.trim()) throw new Error("Escribe las instrucciones de la habilidad.");
	const dir = join(SHIRO_SKILLS_DIR, slug);

	let extra = "";
	let previousDir: string | null = null;
	if (input.originalId) {
		const prev = findSkillById(input.originalId);
		if (!prev || prev.source !== "shiro") throw new Error("Solo se pueden editar las habilidades de Shiro.");
		extra = extraMetaLines(parseSkillMarkdown(readFileSync(prev.file, "utf-8")).rawMeta);
		previousDir = prev.dir;
	}
	const renamed = previousDir !== null && resolve(previousDir) !== resolve(dir);
	if ((previousDir === null || renamed) && existsSync(dir)) {
		throw new Error(`Ya existe una habilidad llamada "${slug}".`);
	}
	// Al cambiar de nombre se mueve la carpeta entera (con sus referencias y scripts).
	if (renamed) renameSync(previousDir!, dir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), buildSkillMarkdown(slug, input.description, input.instructions, extra), "utf-8");
	clearSkillCache();
	return `shiro:${slug}`;
}

/** Guarda un SKILL.md subido por el usuario como habilidad de Shiro. */
export function importOwnSkill(markdown: string, fallbackName: string): string {
	const text = markdown.replace(/^﻿/, "");
	if (!text.trim()) throw new Error("El archivo está vacío.");
	if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("El archivo es demasiado grande (máx. 256 KB).");
	const { meta, body, rawMeta } = parseSkillMarkdown(text);
	const slug = skillSlug(meta.name || fallbackName);
	if (!slug) throw new Error("No pude sacar un nombre para la habilidad: añade 'name:' al encabezado.");
	const dir = join(SHIRO_SKILLS_DIR, slug);
	if (existsSync(dir)) throw new Error(`Ya existe una habilidad llamada "${slug}".`);
	const description = meta.description || body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || slug;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), buildSkillMarkdown(slug, description, body, extraMetaLines(rawMeta)), "utf-8");
	clearSkillCache();
	return `shiro:${slug}`;
}

export function deleteOwnSkill(id: string): void {
	const skill = findSkillById(id);
	if (!skill || skill.source !== "shiro") throw new Error("Solo se pueden borrar las habilidades de Shiro.");
	const dir = resolve(skill.dir);
	if (!dir.startsWith(resolve(SHIRO_SKILLS_DIR) + sep)) throw new Error("Ruta de habilidad no válida.");
	rmSync(dir, { recursive: true, force: true });
	clearSkillCache();
}
