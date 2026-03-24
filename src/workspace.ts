import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
export const WORKSPACE_DIR = join(DATA_DIR, "workspace");
const MEMORY_DIR = join(WORKSPACE_DIR, "memory");

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

/** Crea el workspace y archivos por defecto si no existen. */
export function ensureWorkspace(): void {
	ensureDir(WORKSPACE_DIR);
	ensureDir(MEMORY_DIR);
	writeIfMissing(join(WORKSPACE_DIR, "SOUL.md"), SOUL_TEMPLATE);
	writeIfMissing(join(WORKSPACE_DIR, "HEARTBEAT.md"), HEARTBEAT_TEMPLATE);
	writeIfMissing(join(WORKSPACE_DIR, "MEMORY.md"), "# MEMORY.md — Memoria a largo plazo\n\nHechos, decisiones y contexto que quieres recordar.\n");
	writeIfMissing(join(WORKSPACE_DIR, "TOOLS.md"), TOOLS_TEMPLATE);
	ensureDir(join(WORKSPACE_DIR, "skills"));
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
	return readFileSafe(join(WORKSPACE_DIR, "SOUL.md"));
}

/** Contenido de MEMORY.md (memoria a largo plazo). */
export function readMemoryLongTerm(): string | null {
	return readFileSafe(join(WORKSPACE_DIR, "MEMORY.md"));
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
		const content = readFileSafe(join(MEMORY_DIR, `${date}.md`));
		if (content) {
			const slice = content.length > maxCharsPerFile ? content.slice(0, maxCharsPerFile) + "\n…" : content;
			out += `## memory/${date}.md\n${slice}\n\n`;
		}
	}
	return out.trim() || "";
}

/** Contenido de HEARTBEAT.md (checklist para tareas periódicas). */
export function readHeartbeat(): string | null {
	return readFileSafe(join(WORKSPACE_DIR, "HEARTBEAT.md"));
}

/** Contenido de TOOLS.md (heurísticas de uso de herramientas). */
export function readToolsGuide(): string | null {
	ensureWorkspace();
	return readFileSafe(join(WORKSPACE_DIR, "TOOLS.md"));
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
