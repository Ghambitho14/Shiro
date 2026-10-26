import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DATA_DIR } from "./config/config.js";
import { obsidianRoot } from "./storage/obsidian.js";
import { currentStorage, type StorageSettings } from "./storage/storage.js";

/** Workspace en este equipo. Las habilidades propias (skills/) viven siempre aquí. */
export const LOCAL_WORKSPACE_DIR = join(DATA_DIR, "workspace");

/** Carpeta de las notas de memoria (SOUL.md, MEMORY.md, memory/) y de write_file para unos ajustes. */
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
- **Usa contexto.** Estos archivos (SOUL, MEMORY, memory/) son tu continuidad. Léelos y actualízalos.
- **Respeta la intimidad.** Lo privado se queda privado.

## Límites

- No envíes respuestas a medias. Si dudas, pregunta antes de actuar fuera del chat.
- Eres el asistente; no suplantes la voz del usuario.

## Continuidad

Cada sesión empieza fresca. SOUL.md, MEMORY.md y memory/YYYY-MM-DD.md son tu memoria. Actualízalos cuando aprendas algo que deba persistir.
`;

const HEARTBEAT_TEMPLATE = `# HEARTBEAT.md — Tareas periódicas

Lista corta de cosas que revisar cuando haya un heartbeat (ej. recordatorios, comprobaciones).

- [ ] Revisar si hay algo urgente
- [ ] Actualizar memory/ con lo relevante del día

Si no hay nada que hacer, responde HEARTBEAT_OK.
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
	ensureDir(join(dir, "memory"));
	writeIfMissing(join(dir, "SOUL.md"), SOUL_TEMPLATE);
	writeIfMissing(join(dir, "HEARTBEAT.md"), HEARTBEAT_TEMPLATE);
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

/** Fecha en YYYY-MM-DD (local). */
function todayISO(): string {
	const d = new Date();
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** Contenido de memory/YYYY-MM-DD.md para hoy y ayer (máx. ~4k chars por archivo). */
export function readMemoryRecent(maxCharsPerFile = 4000): string {
	ensureWorkspace();
	const today = todayISO();
	const yesterday = (() => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
	})();
	let out = "";
	for (const date of [today, yesterday]) {
		const content = readFileSafe(join(getWorkspaceDir(), "memory", `${date}.md`));
		if (content) {
			const slice = content.length > maxCharsPerFile ? content.slice(0, maxCharsPerFile) + "\n…" : content;
			out += `## memory/${date}.md\n${slice}\n\n`;
		}
	}
	return out.trim() || "";
}

/** Contenido de HEARTBEAT.md (checklist para tareas periódicas). */
/** Contenido de TOOLS.md (heurísticas de uso de herramientas). */
export function readToolsGuide(): string | null {
	ensureWorkspace();
	return readFileSafe(join(getWorkspaceDir(), "TOOLS.md"));
}

/** Construye el bloque de contexto (soul + memory) para inyectar en el system prompt. */
export function buildWorkspaceContext(opts: { includeLongTermMemory?: boolean } = {}): string {
	const soul = readSoul();
	const toolsGuide = readToolsGuide();
	const recent = readMemoryRecent();
	const longTerm = opts.includeLongTermMemory ? readMemoryLongTerm() : null;
	const parts: string[] = [];
	if (soul) parts.push("## SOUL.md (quién eres)\n" + soul);
	if (toolsGuide) parts.push("## TOOLS.md (guía de herramientas)\n" + toolsGuide);
	if (recent) parts.push("## Memoria reciente (hoy/ayer)\n" + recent);
	if (longTerm) parts.push("## MEMORY.md (memoria a largo plazo)\n" + longTerm);
	return parts.length ? parts.join("\n\n") : "";
}
