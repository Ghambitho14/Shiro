/** Utilidades de texto compartidas con Shiro del PC (mismas reglas para títulos, vistas previas y búsqueda). */
import type { ChatMessage, ContentPart } from "./types";

export function messageText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

const preview = (m: ChatMessage) => messageText(m.content).replace(/\s+/g, " ").trim();

export function chatTitle(messages: ChatMessage[], fallback = "Nueva sesión"): string {
	const first = messages.find((m) => m.role === "user" && preview(m).length > 0);
	if (!first) return fallback;
	const t = preview(first);
	return t.length <= 40 ? t : t.slice(0, 40) + "...";
}

export function chatPreview(messages: ChatMessage[]): string {
	const last = [...messages].reverse().find((m) => preview(m).length > 0);
	if (!last) return "";
	const t = preview(last);
	return t.length <= 80 ? t : t.slice(0, 80) + "...";
}

const STOPWORDS = new Set(
	"de la el los las un una unos unas que en por con para del al lo le les se su sus mi mis me te tu tus yo y o u a e es son fue ser sobre como cual cuando donde algo eso esto este esta ese esa muy mas pero sin ya hay nos the and for with".split(" "),
);

const plain = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

/** Palabras de una búsqueda, sin tildes ni palabras vacías ("de", "la"…). */
export function keywords(text: string): string[] {
	const words = plain(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
	return [...new Set(words)];
}

/** Fracción de las palabras buscadas que aparecen en el texto (0 a 1). */
export function keywordScore(words: string[], text: string): number {
	if (!words.length) return 0;
	const hay = plain(text);
	return words.filter((w) => hay.includes(w)).length / words.length;
}

/** Fecha de hoy como la escribe Shiro en MEMORY.md (AAAA-MM-DD). */
export function isoDay(d = new Date()): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Quita las propiedades de arriba de una nota de Obsidian (--- … ---) y devuelve { meta, body }. */
export function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!m) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([\w-]+):\s*(.*)$/.exec(line);
		if (kv) meta[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
	}
	return { meta, body: text.slice(m[0].length) };
}

/** id nuevo (los chats del PC usan UUID; aquí vale cualquiera único). */
export function newId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
		const r = (Math.random() * 16) | 0;
		return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

/** Texto para leer: sin markdown, enlaces ni bloques de código (como hace la web). */
export function speakable(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " (bloque de código) ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "")
		.replace(/^\s*#+\s*/gm, "")
		.replace(/^\s*[-*•]\s+/gm, "")
		.replace(/[*_~>|]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
