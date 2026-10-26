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
El usuario te escribe desde su teléfono. Aquí solo tienes estas herramientas: memory_search y memory_add (tu memoria compartida con el PC), search_web y fetch_url (internet).
No puedes controlar el PC, abrir programas, leer sus archivos ni usar la terminal: si te lo pide, dile que lo haga desde Shiro en el PC.
Responde corto: se lee en una pantalla pequeña.`;

const MEMORY_GUIDE = `## Tu memoria
Tu memoria está en Supabase, compartida con Shiro del PC: MEMORY.md (lo importante y duradero, lo tienes más abajo), «Sobre mí», tus recuerdos y los chats. Lo que aprendas aquí lo sabrás también en el PC.
Cuando aprendas algo del usuario que valga la pena recordar, guárdalo con memory_add (important=true si debes tenerlo siempre presente: su nombre, gustos, proyectos…). Para recordar algo, búscalo con memory_search antes de decir que no lo sabes.`;

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

export function buildSystemPrompt(notes: Notes, opts: { assistantName?: string; now?: Date } = {}): string {
	const name = assistantNameFrom(notes, opts.assistantName);
	const profile = profileBlock(notes["Sobre mí.md"]);
	const base = (notes["Instrucciones.md"]?.trim() || FALLBACK_INSTRUCTIONS)
		.replace(/\{\{nombre\}\}/g, name)
		.replace(/\{\{usuario\}\}/g, profile.userName || "el usuario")
		.replace(/\{\{carpeta\}\}/g, "(en el móvil no hay carpeta)")
		.replace(/\{\{fecha\}\}/g, formatDate(opts.now ?? new Date()));
	const parts = [base, MOBILE_BLOCK];
	if (profile.text) parts.push(profile.text);
	const workspace = [MEMORY_GUIDE];
	if (notes["SOUL.md"]?.trim()) workspace.push(`## SOUL.md (quién eres)\n${notes["SOUL.md"].trim()}`);
	if (notes["MEMORY.md"]?.trim()) workspace.push(`## MEMORY.md (memoria a largo plazo)\n${notes["MEMORY.md"].trim()}`);
	parts.push(`## Contexto workspace\n${workspace.join("\n\n").slice(0, 8000)}`);
	return parts.join("\n\n");
}
