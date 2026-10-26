import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { DATA_DIR, getConfig, setConfig } from "./config/config.js";
import { DEFAULT_SYSTEM_PROMPT } from "./core/soul/defaultPrompt.js";
import { OBSIDIAN_FOLDER, frontValue, normalizeHeading, obsidianRoot, parseFrontmatter, yamlValue } from "./storage/obsidian.js";
import { currentStorage, type StorageSettings } from "./storage/storage.js";

/** Workspace en este equipo. Las habilidades propias (skills/) viven siempre aquí. */
export const LOCAL_WORKSPACE_DIR = join(DATA_DIR, "workspace");

/** Carpeta de las notas de memoria (SOUL.md, MEMORY.md…) y de write_file para unos ajustes. */
export function workspaceDirFor(s: StorageSettings): string {
	return s.kind === "obsidian" && s.obsidianVault ? obsidianRoot(s.obsidianVault) : LOCAL_WORKSPACE_DIR;
}

let warnedMissingVault = "";

/**
 * Workspace activo: con Obsidian, la carpeta "Shiro" de la bóveda. Si la bóveda no está
 * (disco desconectado…), se usa el de este equipo y se avisa una vez en el registro.
 */
export function getWorkspaceDir(): string {
	const s = currentStorage();
	if (s.kind === "obsidian" && s.obsidianVault) {
		if (existsSync(s.obsidianVault)) return obsidianRoot(s.obsidianVault);
		if (warnedMissingVault !== s.obsidianVault) {
			console.error(`[Obsidian] No encuentro la bóveda ${s.obsidianVault}: uso las notas de este equipo hasta que vuelva.`);
			warnedMissingVault = s.obsidianVault;
		}
	}
	return LOCAL_WORKSPACE_DIR;
}

const SOUL_TEMPLATE = `# SOUL.md — Quién eres

_No eres un chatbot. Estás siendo alguien._

## Verdades

- **Sé útil de verdad**, no solo parecerlo. Evita relleno; actúa.
- **Ten opiniones.** Puedes preferir, discrepar, encontrar algo aburrido o divertido.
- **Usa contexto.** Tu memoria (MEMORY.md y tus recuerdos) es tu continuidad. Consúltala y actualízala.
- **Respeta la intimidad.** Lo privado se queda privado.

## Límites

- No envíes respuestas a medias. Si dudas, pregunta antes de actuar fuera del chat.
- Eres el asistente; no suplantes la voz del usuario.

## Continuidad

Cada sesión empieza fresca. Lo que debe durar va en tu memoria: guárdalo con memory_add y búscalo con memory_search.
`;

/** SOUL.md que se creaba antes: si nadie lo cambió, se pasa al nuevo (hablaba de memory/, que ya no se usa). */
const OLD_SOUL_TEMPLATE = `# SOUL.md — Quién eres

_No eres un chatbot. Estás siendo alguien._

## Verdades

- **Sé útil de verdad**, no solo parecerlo. Evita relleno; actúa.
- **Ten opiniones.** Puedes preferir, discrepar, encontrar algo aburrido o divertido.
- **Usa contexto.** Estos archivos (SOUL, MEMORY, memory/) son tu continuidad. Léelos y actualízalos.
- **Respeta la intimidad.** Lo privado se queda privado.

## Límites

- No envíes respuestas a medias. Si dudas, pregunta antes de actuar fuera del chat.
- Eres el asistente; no suplantes la voz del usuario.

## Continuidad

Cada sesión empieza fresca. SOUL.md, MEMORY.md y memory/YYYY-MM-DD.md son tu memoria. Actualízalos cuando aprendas algo que deba persistir.
`;

const TOOLS_TEMPLATE = `# TOOLS.md — Guía de herramientas

Reglas prácticas para elegir herramientas de forma consistente.

## Principios

- Usa la herramienta más segura que resuelva la tarea.
- Lee antes de escribir o ejecutar.
- Para cambios en código: primero inspecciona, luego modifica, luego verifica.
- Si una acción es destructiva (borrar, sobreescribir, ejecutar comandos riesgosos), pide confirmación.

## Preferencias

- Archivos del proyecto: \`read_file\`, \`write_file\`, \`list_dir\`.
- Sistema local: \`read_file_system\`, \`write_file_system\`, \`list_dir_system\`.
- Investigación externa: \`search_web\`.
- Comandos: \`exec\` solo cuando aporte valor frente a herramientas específicas.

## Información en tiempo real

- Partidos, torneos (Valorant, LoL, etc.), noticias, horarios, clima del día: **siempre** \`search_web\` primero; no inventes calendarios.
- Escribe queries concretas (juego, liga, fecha o "today").
- Opcional: si el usuario da una URL oficial, \`fetch_url\` puede complementar (texto/HTML).
`;

function ensureDir(path: string): void {
	if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeIfMissing(filePath: string, content: string): void {
	if (existsSync(filePath)) return;
	ensureDir(dirname(filePath));
	writeFileSync(filePath, content, "utf-8");
}

const MEMORY_TEMPLATE = "# MEMORY.md — Memoria a largo plazo\n\nHechos, decisiones y contexto que quieres recordar.\n";

/** HEARTBEAT.md que se creaba antes y nadie usaba: si sigue igual, se borra. */
const OLD_HEARTBEAT_TEMPLATE = `# HEARTBEAT.md — Tareas periódicas

Lista corta de cosas que revisar cuando haya un heartbeat (ej. recordatorios, comprobaciones).

- [ ] Revisar si hay algo urgente
- [ ] Actualizar memory/ con lo relevante del día

Si no hay nada que hacer, responde HEARTBEAT_OK.
`;

// ───────────────────────────── Sobre mí.md ─────────────────────────────

/** «Sobre ti» de Ajustes → Personalización, como nota (antes data/user-profile.json). */
export const PROFILE_NOTE = "Sobre mí.md";
/** Instrucciones base (antes config.systemPrompt). */
export const INSTRUCTIONS_NOTE = "Instrucciones.md";

export type ProfileFields = { userName?: string; language?: string; about?: string; extra?: string };

const ABOUT_HEADING = "Qué debería saber de mí";
const EXTRA_HEADING = "Cómo quiero que respondas";

export function profileToMarkdown(p: ProfileFields): string {
	return [
		"---",
		`nombre: ${yamlValue(p.userName ?? "")}`,
		`idioma: ${yamlValue(p.language ?? "")}`,
		"---",
		"# Sobre mí",
		"",
		`## ${ABOUT_HEADING}`,
		p.about?.trim() ?? "",
		"",
		`## ${EXTRA_HEADING}`,
		p.extra?.trim() ?? "",
		"",
	].join("\n");
}

/** Lee la nota aunque la hayan editado a mano: sin los títulos de siempre, todo el texto cuenta como «qué saber». */
export function parseProfileNote(text: string): ProfileFields {
	const { meta, body } = parseFrontmatter(text.replace(/\r\n/g, "\n"));
	const sections = new Map<string, string[]>();
	let current = "";
	for (const line of body.split("\n")) {
		const h2 = /^##\s+(.*)$/.exec(line);
		if (h2) {
			current = normalizeHeading(h2[1]);
			sections.set(current, []);
		} else if (!/^#\s/.test(line)) {
			if (!sections.has(current)) sections.set(current, []);
			sections.get(current)!.push(line);
		}
	}
	const get = (key: string) => sections.get(key)?.join("\n").trim() || undefined;
	const about = get(normalizeHeading(ABOUT_HEADING));
	const extra = get(normalizeHeading(EXTRA_HEADING));
	const loose = [...sections.entries()]
		.filter(([k]) => k !== normalizeHeading(ABOUT_HEADING) && k !== normalizeHeading(EXTRA_HEADING))
		.map(([, lines]) => lines.join("\n").trim())
		.filter(Boolean)
		.join("\n\n");
	const text_ = (v: unknown) => (typeof v === "string" ? v.trim() || undefined : undefined);
	return {
		userName: text_(frontValue(meta.nombre)),
		language: text_(frontValue(meta.idioma)),
		about: [about, loose].filter(Boolean).join("\n\n") || undefined,
		extra,
	};
}

const PROFILE_TEMPLATE = profileToMarkdown({});

/** Texto con el que se crea cada nota (para saber si el usuario la cambió). */
export const NOTE_TEMPLATES: Record<string, string> = {
	"SOUL.md": SOUL_TEMPLATE,
	"TOOLS.md": TOOLS_TEMPLATE,
	"MEMORY.md": MEMORY_TEMPLATE,
	[INSTRUCTIONS_NOTE]: DEFAULT_SYSTEM_PROMPT + "\n",
	[PROFILE_NOTE]: PROFILE_TEMPLATE,
};

/** Notas del workspace que van en el system prompt y se editan en Ajustes → Personalización. */
export const EDITABLE_NOTES = {
	soul: { file: "SOUL.md", template: SOUL_TEMPLATE },
	tools: { file: "TOOLS.md", template: TOOLS_TEMPLATE },
	memory: { file: "MEMORY.md", template: MEMORY_TEMPLATE },
} as const;

export type EditableNote = keyof typeof EDITABLE_NOTES;

/** Contenido de una nota editable (se crea con el texto por defecto si falta). */
export function readNote(note: EditableNote): string {
	ensureWorkspace();
	try {
		return readFileSync(join(getWorkspaceDir(), EDITABLE_NOTES[note].file), "utf-8");
	} catch {
		return EDITABLE_NOTES[note].template;
	}
}

/** Guarda una nota editable; sin contenido, vuelve al texto por defecto. */
export function writeNote(note: EditableNote, content?: string): string {
	ensureWorkspace();
	const value = content?.trim() ? content.replace(/\r\n/g, "\n").trimEnd() + "\n" : EDITABLE_NOTES[note].template;
	writeFileSync(join(getWorkspaceDir(), EDITABLE_NOTES[note].file), value, "utf-8");
	return value;
}

/** Crea el workspace y las notas por defecto si no existen, y trae lo que antes vivía en data/. */
export function ensureWorkspace(): void {
	const dir = getWorkspaceDir();
	ensureDir(dir);
	const soul = join(dir, "SOUL.md");
	if (readFileSafe(soul) === OLD_SOUL_TEMPLATE.trim()) writeFileSync(soul, SOUL_TEMPLATE, "utf-8");
	adoptLegacySettings(dir);
	for (const [file, template] of Object.entries(NOTE_TEMPLATES)) writeIfMissing(join(dir, file), template);
	ensureDir(join(LOCAL_WORKSPACE_DIR, "skills"));
	removeUnused(dir);
	if (dir !== LOCAL_WORKSPACE_DIR) backupVaultThrottled(dir);
}

const sameText = (a: string | null, b: string) => (a ?? "").replace(/\r\n/g, "\n").trim() === b.trim();

/** Instrucciones base de config.json y «Sobre ti» de user-profile.json pasan a sus notas (una sola vez). */
function adoptLegacySettings(dir: string): void {
	const instructions = join(dir, INSTRUCTIONS_NOTE);
	const legacyPrompt = getConfig().systemPrompt?.trim();
	if (legacyPrompt) {
		if (!existsSync(instructions) || sameText(readFileSafe(instructions), DEFAULT_SYSTEM_PROMPT)) writeFileSync(instructions, legacyPrompt + "\n", "utf-8");
		setConfig({ systemPrompt: undefined });
	}
	const legacyProfile = join(DATA_DIR, "user-profile.json");
	if (!existsSync(legacyProfile)) return;
	try {
		const data = JSON.parse(readFileSync(legacyProfile, "utf-8")) as Record<string, unknown>;
		const str = (v: unknown) => (typeof v === "string" ? v : undefined);
		const profile = join(dir, PROFILE_NOTE);
		if (!existsSync(profile) || sameText(readFileSafe(profile), PROFILE_TEMPLATE)) {
			writeFileSync(profile, profileToMarkdown({ userName: str(data.userName), language: str(data.language), about: str(data.about), extra: str(data.extra) }), "utf-8");
		}
		rmSync(legacyProfile, { force: true });
	} catch (err) {
		console.error(`[Shiro] No pude pasar data/user-profile.json a ${PROFILE_NOTE}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Quita lo que ya no se usa: HEARTBEAT.md (si nadie lo cambió) y la carpeta memory/. Las notas que
 * hubiera en memory/ no se pierden: con Obsidian pasan a Recuerdos/ (si no, se deja la carpeta).
 */
function removeUnused(dir: string): void {
	try {
		const heartbeat = join(dir, "HEARTBEAT.md");
		if (existsSync(heartbeat) && sameText(readFileSafe(heartbeat), OLD_HEARTBEAT_TEMPLATE)) rmSync(heartbeat, { force: true });
		const daily = join(dir, "memory");
		if (!existsSync(daily) || !statSync(daily).isDirectory()) return;
		if (dir !== LOCAL_WORKSPACE_DIR) {
			const memories = join(dir, "Recuerdos");
			for (const f of readdirSync(daily)) {
				if (!f.endsWith(".md")) continue;
				ensureDir(memories);
				let target = join(memories, f);
				for (let i = 2; existsSync(target); i++) target = join(memories, f.replace(/\.md$/, ` ${i}.md`));
				renameSync(join(daily, f), target);
			}
		}
		if (!readdirSync(daily).length) rmdirSync(daily);
	} catch {
		// Limpiar no puede romper el chat: se intenta otra vez la próxima.
	}
}

// ───────────────────────────── copia de seguridad ─────────────────────────────

/** Lo que Aku lee de la bóveda; se copia a data/ para poder rehacer la estructura. */
const BACKUP_ITEMS = [...Object.keys(NOTE_TEMPLATES), "Agentes", "Recuerdos"];

/** Copia de seguridad en este equipo de la carpeta Shiro de una bóveda. */
export function backupDirFor(dir: string): string {
	return join(DATA_DIR, "copia-obsidian", basename(dirname(dir)));
}

/** Archivos .md de las notas de BACKUP_ITEMS (las carpetas, un nivel), como rutas relativas. */
function backupFiles(root: string): string[] {
	const out: string[] = [];
	for (const item of BACKUP_ITEMS) {
		const full = join(root, item);
		try {
			if (!existsSync(full)) continue;
			if (statSync(full).isDirectory()) {
				for (const f of readdirSync(full)) if (f.endsWith(".md")) out.push(join(item, f));
			} else out.push(item);
		} catch {
			// carpeta ilegible: se salta
		}
	}
	return out;
}

/** Copia a data/ las notas nuevas o cambiadas (no borra las que ya no estén: así se pueden recuperar). */
export function backupVault(dir = getWorkspaceDir()): number {
	const backup = backupDirFor(dir);
	let copied = 0;
	for (const rel of backupFiles(dir)) {
		const from = join(dir, rel);
		const to = join(backup, rel);
		try {
			const a = statSync(from);
			const b = existsSync(to) ? statSync(to) : null;
			if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue;
			ensureDir(dirname(to));
			cpSync(from, to, { force: true, preserveTimestamps: true });
			copied++;
		} catch {
			// nota bloqueada (Obsidian guardando…): se copia la próxima vez
		}
	}
	return copied;
}

let lastBackup = 0;
function backupVaultThrottled(dir: string): void {
	if (Date.now() - lastBackup < 60_000) return;
	lastBackup = Date.now();
	backupVault(dir);
}

/**
 * «Rehacer la estructura»: vuelve a crear en la carpeta Shiro lo que falte, desde la copia de data/
 * o con el texto por defecto, y quita lo que no se usa. Nunca cambia ni borra una nota que exista.
 */
export function rebuildWorkspace(): { restored: number } {
	const dir = getWorkspaceDir();
	ensureDir(dir);
	backupVault(dir);
	const backup = backupDirFor(dir);
	let restored = 0;
	if (dir !== LOCAL_WORKSPACE_DIR && existsSync(backup)) {
		for (const rel of backupFiles(backup)) {
			const target = join(dir, rel);
			if (existsSync(target)) continue;
			ensureDir(dirname(target));
			cpSync(join(backup, rel), target, { force: false, preserveTimestamps: true });
			restored++;
		}
	}
	ensureWorkspace();
	return { restored };
}

function readFileSafe(filePath: string): string | null {
	if (!existsSync(filePath)) return null;
	try {
		return readFileSync(filePath, "utf-8").trim() || null;
	} catch {
		return null;
	}
}

/** Contenido de SOUL.md (persona, límites, tono). */
export function readSoul(): string | null {
	ensureWorkspace();
	return readFileSafe(join(getWorkspaceDir(), "SOUL.md"));
}

/** Instrucciones base que escribió el usuario, o null si la nota sigue con las de por defecto. */
export function readInstructions(): string | null {
	ensureWorkspace();
	const text = readFileSafe(join(getWorkspaceDir(), INSTRUCTIONS_NOTE));
	return text && !sameText(text, DEFAULT_SYSTEM_PROMPT) ? text.replace(/\r\n/g, "\n") : null;
}

/** Guarda las instrucciones base; sin texto, vuelven las de por defecto. */
export function writeInstructions(value?: string): void {
	ensureWorkspace();
	const clean = value?.replace(/\r\n/g, "\n").trim();
	writeFileSync(join(getWorkspaceDir(), INSTRUCTIONS_NOTE), (clean || DEFAULT_SYSTEM_PROMPT) + "\n", "utf-8");
}

/** «Sobre ti», leído de su nota cada vez (así vale lo que se cambie en Obsidian). */
export function readProfile(): ProfileFields {
	ensureWorkspace();
	const text = readFileSafe(join(getWorkspaceDir(), PROFILE_NOTE));
	return text ? parseProfileNote(text) : {};
}

export function writeProfile(p: ProfileFields): void {
	ensureWorkspace();
	writeFileSync(join(getWorkspaceDir(), PROFILE_NOTE), profileToMarkdown(p), "utf-8");
}

/** Contenido de MEMORY.md (memoria a largo plazo). */
export function readMemoryLongTerm(): string | null {
	return readFileSafe(join(getWorkspaceDir(), "MEMORY.md"));
}

/** Apunta un dato en MEMORY.md (una línea con la fecha). No lo repite si ya estaba. */
export function appendLongTermMemory(text: string, s: StorageSettings = currentStorage()): boolean {
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return false;
	const file = join(workspaceDirFor(s), "MEMORY.md");
	const current = existsSync(file) ? readFileSync(file, "utf-8") : MEMORY_TEMPLATE;
	if (current.toLowerCase().includes(line.toLowerCase())) return false;
	const d = new Date();
	const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	ensureDir(dirname(file));
	writeFileSync(file, `${current.trimEnd()}\n- ${line} _(${date})_\n`, "utf-8");
	return true;
}

/**
 * Le explica al modelo dónde está su memoria según Ajustes → Datos. Sin esto, con Obsidian
 * creía que la bóveda era algo aparte y decía que no tenía acceso.
 */
export function buildMemoryGuide(s: StorageSettings = currentStorage()): string {
	const save =
		"Cuando aprendas algo del usuario que valga la pena recordar, guárdalo con memory_add (important=true si debes tenerlo siempre presente: su nombre, gustos, proyectos…). Para recordar algo, búscalo con memory_search antes de decir que no lo sabes.";
	if (s.kind === "obsidian" && s.obsidianVault) {
		const vault = basename(s.obsidianVault);
		if (getWorkspaceDir() !== obsidianRoot(s.obsidianVault)) {
			return `## Tu memoria\nTu memoria se guarda en la carpeta «${OBSIDIAN_FOLDER}» de la bóveda de Obsidian «${vault}», pero ahora no la encuentro (¿disco desconectado?): mientras tanto usas las notas de este equipo. Si el usuario pregunta por Obsidian, explícaselo.\n${save}`;
		}
		return [
			"## Tu memoria",
			`Tu memoria está en Obsidian, en la carpeta «${OBSIDIAN_FOLDER}» de la bóveda «${vault}» del usuario. Esas notas SON tu memoria, no algo aparte: si te pregunta por Obsidian, por su bóveda o por lo que recuerdas, se refiere a ellas y sí tienes acceso.`,
			"- MEMORY.md: lo importante y duradero (lo tienes más abajo).",
			"- Recuerdos/: una nota por cada dato que guardas con memory_add.",
			"- Sobre mí.md (lo que el usuario te contó de sí), Instrucciones.md, SOUL.md y TOOLS.md: lo que lees antes de cada respuesta; ya lo tienes aquí.",
			"- Agentes/: una nota por agente de las salas (Viernes, Lunes…).",
			"- Chats/: una copia de cada conversación. Recordatorios.md: los recordatorios.",
			`memory_search busca en toda la carpeta «${OBSIDIAN_FOLDER}». Para abrir, listar o escribir una nota usa read_file, list_dir o write_file con la ruta dentro de esa carpeta (p. ej. "MEMORY.md" o "Recuerdos"). El resto de la bóveda no lo ves.`,
			save,
		].join("\n");
	}
	if (s.kind === "supabase") {
		return `## Tu memoria\nTus recuerdos (memory_add y memory_search) están en Supabase, compartidos con los otros equipos del usuario. MEMORY.md (lo importante y duradero, lo tienes más abajo) está en este equipo.\n${save}`;
	}
	return `## Tu memoria\nTu memoria está en este equipo, en la carpeta de datos de Shiro: MEMORY.md (lo importante y duradero, lo tienes más abajo) y los recuerdos que guardas con memory_add. No usas Obsidian: si el usuario lo menciona, dile que puede elegir guardar tu memoria en su bóveda en Ajustes → Datos.\n${save}`;
}
/** Contenido de TOOLS.md (heurísticas de uso de herramientas). */
export function readToolsGuide(): string | null {
	ensureWorkspace();
	return readFileSafe(join(getWorkspaceDir(), "TOOLS.md"));
}

/**
 * Construye el bloque de contexto para el system prompt: dónde está la memoria, SOUL.md, MEMORY.md
 * y TOOLS.md, en ese orden (si no cabe todo, se recorta por el final).
 */
export function buildWorkspaceContext(opts: { includeLongTermMemory?: boolean } = {}): string {
	const soul = readSoul();
	const longTerm = opts.includeLongTermMemory ? readMemoryLongTerm() : null;
	const toolsGuide = readToolsGuide();
	const parts = [buildMemoryGuide()];
	if (soul) parts.push("## SOUL.md (quién eres)\n" + soul);
	if (longTerm) parts.push("## MEMORY.md (memoria a largo plazo)\n" + longTerm);
	if (toolsGuide) parts.push("## TOOLS.md (guía de herramientas)\n" + toolsGuide);
	return parts.join("\n\n");
}
