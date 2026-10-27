/**
 * El system prompt del móvil, armado con las mismas notas que lee Shiro en el PC (shiro_notes):
 * instrucciones base, «Sobre mí», SOUL.md y MEMORY.md. Así el asistente es el mismo en los dos sitios.
 */
import type { Notes } from "./supabase";
import { splitFrontmatter } from "./text";

const FALLBACK_INSTRUCTIONS = `Eres {{nombre}}, un asistente personal.
El usuario actual es "{{usuario}}".
Fecha y hora actual: {{fecha}}

## Reglas
- Responde de forma directa y concisa
- Para información actual (noticias, deportes, precios, clima): usa search_web antes de decir que no sabes
- Si algo es ambiguo, pregunta`;

export const MOBILE_BLOCK = `## Estás en la app del móvil
El usuario te escribe desde su teléfono. Aquí solo tienes estas herramientas: memory_search y memory_add (tu memoria compartida con el PC), search_web y fetch_url (internet), y create_reminder, list_reminders y complete_reminder (los mismos recordatorios que en el PC; el teléfono avisa cuando toca). Para create_reminder da la fecha en ISO con la hora local del usuario (fecha y hora actual arriba) o «en 30 minutos».
No puedes controlar el PC, abrir programas, leer sus archivos ni usar la terminal: si te lo pide, dile que lo haga desde Shiro en el PC.
Responde corto: se lee en una pantalla pequeña.`;

const MEMORY_GUIDE = `## Tu memoria
Tu memoria está en Supabase, compartida con Shiro del PC: MEMORY.md (lo importante y duradero, lo tienes más abajo), «Sobre mí», tus recuerdos y los chats. Lo que aprendas aquí lo sabrás también en el PC.
Cuando aprendas algo del usuario que valga la pena recordar, guárdalo con memory_add (important=true si debes tenerlo siempre presente: su nombre, gustos, proyectos…). Para recordar algo, búscalo con memory_search antes de decir que no lo sabes.`;

/** Igual que VOICE_BLOCK de src/core/agent/ContextBuilder.ts del PC. */
export const VOICE_BLOCK = `## Modo voz
El usuario te habla por voz y tu respuesta se leerá en voz alta:
- Responde en 1 a 3 frases cortas y naturales, como en una conversación.
- Sin markdown, listas, tablas, emojis, enlaces ni bloques de código.
- Si la respuesta sería larga, da lo esencial y ofrece ampliar.`;

/** Nombre del asistente: el de Ajustes de la app o el que tiene Shiro en el PC. */
export function assistantNameFrom(notes: Notes, override = ""): string {
	if (override.trim()) return override.trim();
	try {
		const info = JSON.parse(notes["_shiro.json"] ?? "{}") as { assistantName?: unknown };
		if (typeof info.assistantName === "string" && info.assistantName.trim()) return info.assistantName.trim();
	} catch {
		// nota rara: se usa el de siempre
	}
	return "Shiro";
}

/** «Sobre mí» sin las secciones vacías. */
export function profileBlock(note: string | undefined): { userName: string; text: string } {
	if (!note?.trim()) return { userName: "", text: "" };
	const { meta, body } = splitFrontmatter(note.replace(/\r\n/g, "\n"));
	const lines: string[] = [];
	if (meta.nombre) lines.push(`Nombre: ${meta.nombre}`);
	if (meta.idioma) lines.push(`Idioma preferido: ${meta.idioma}`);
	for (const section of body.replace(/^# .*\n?/m, "").split(/\n(?=## )/)) {
		const [head, ...rest] = section.split("\n");
		const content = (head.startsWith("## ") ? rest : [head, ...rest]).join("\n").trim();
		if (content) lines.push(head.startsWith("## ") ? `${head.slice(3).trim()}: ${content}` : content);
	}
	return { userName: meta.nombre ?? "", text: lines.length ? `## Sobre el usuario\n${lines.join("\n")}` : "" };
}

export function formatDate(d: Date): string {
	try {
		return d.toLocaleString("es", { dateStyle: "full", timeStyle: "short" });
	} catch {
		return d.toISOString();
	}
}

export function buildSystemPrompt(notes: Notes, opts: { assistantName?: string; now?: Date; voice?: boolean } = {}): string {
	const name = assistantNameFrom(notes, opts.assistantName);
	const profile = profileBlock(notes["Sobre mí.md"]);
	const base = (notes["Instrucciones.md"]?.trim() || FALLBACK_INSTRUCTIONS)
		.replace(/\{\{nombre\}\}/g, name)
		.replace(/\{\{usuario\}\}/g, profile.userName || "el usuario")
		.replace(/\{\{carpeta\}\}/g, "(en el móvil no hay carpeta)")
		.replace(/\{\{fecha\}\}/g, formatDate(opts.now ?? new Date()));
	const parts = [base, MOBILE_BLOCK];
	if (opts.voice) parts.push(VOICE_BLOCK);
	if (profile.text) parts.push(profile.text);
	const workspace = [MEMORY_GUIDE];
	if (notes["SOUL.md"]?.trim()) workspace.push(`## SOUL.md (quién eres)\n${notes["SOUL.md"].trim()}`);
	if (notes["MEMORY.md"]?.trim()) workspace.push(`## MEMORY.md (memoria a largo plazo)\n${notes["MEMORY.md"].trim()}`);
	parts.push(`## Contexto workspace\n${workspace.join("\n\n").slice(0, 8000)}`);
	return parts.join("\n\n");
}

// ───────────────────────────── «Sobre ti» (Personalización) ─────────────────────────────

export type ProfileFields = { userName: string; language: string; about: string; extra: string };

/** Mismos títulos que Sobre mí.md del PC (src/workspace.ts profileToMarkdown). */
export const ABOUT_HEADING = "Qué debería saber de mí";
export const EXTRA_HEADING = "Cómo quiero que respondas";

const yaml = (v: string) => JSON.stringify(v);

export function profileToMarkdown(p: ProfileFields): string {
	return ["---", `nombre: ${yaml(p.userName.trim())}`, `idioma: ${yaml(p.language.trim())}`, "---", "# Sobre mí", "", `## ${ABOUT_HEADING}`, p.about.trim(), "", `## ${EXTRA_HEADING}`, p.extra.trim(), ""].join("\n");
}

const plainHeading = (h: string) => h.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().trim();

export function parseProfileNote(text: string | undefined): ProfileFields {
	const out: ProfileFields = { userName: "", language: "", about: "", extra: "" };
	if (!text?.trim()) return out;
	const { meta, body } = splitFrontmatter(text.replace(/\r\n/g, "\n"));
	out.userName = meta.nombre ?? "";
	out.language = meta.idioma ?? "";
	const loose: string[] = [];
	for (const section of body.replace(/^# .*\n?/m, "").split(/\n(?=## )/)) {
		const [head, ...rest] = section.split("\n");
		if (!head.startsWith("## ")) {
			if (section.trim()) loose.push(section.trim());
			continue;
		}
		const content = rest.join("\n").trim();
		const h = plainHeading(head.slice(3));
		if (h === plainHeading(ABOUT_HEADING)) out.about = content;
		else if (h === plainHeading(EXTRA_HEADING)) out.extra = content;
		else if (content) loose.push(content);
	}
	out.about = [out.about, ...loose].filter(Boolean).join("\n\n");
	return out;
}
