import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { OBSIDIAN_FOLDER, obsidianRoot } from "./storage/obsidian.js";
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

/** Texto con el que se crea cada nota (para saber si el usuario la cambió). */
export const NOTE_TEMPLATES: Record<string, string> = { "SOUL.md": SOUL_TEMPLATE, "TOOLS.md": TOOLS_TEMPLATE, "MEMORY.md": MEMORY_TEMPLATE };

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

/** Crea el workspace y archivos por defecto si no existen. */
export function ensureWorkspace(): void {
	const dir = getWorkspaceDir();
	ensureDir(dir);
	const soul = join(dir, "SOUL.md");
	if (readFileSafe(soul) === OLD_SOUL_TEMPLATE.trim()) writeFileSync(soul, SOUL_TEMPLATE, "utf-8");
	writeIfMissing(soul, SOUL_TEMPLATE);
	writeIfMissing(join(dir, "MEMORY.md"), MEMORY_TEMPLATE);
	writeIfMissing(join(dir, "TOOLS.md"), TOOLS_TEMPLATE);
	ensureDir(join(LOCAL_WORKSPACE_DIR, "skills"));
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
