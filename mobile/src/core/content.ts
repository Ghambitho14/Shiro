/**
 * Mensajes con adjuntos, con el mismo formato que la web (public/js/messages.js buildContent):
 * los archivos de texto van dentro del texto entre <<<archivo: nombre>>> … <<<fin del archivo>>>,
 * y las imágenes como partes image_url (data URL). Así los chats se ven igual en el PC.
 */
import type { ContentPart } from "./types";

export type Attachment = { kind: "image"; name: string; dataUrl: string } | { kind: "file"; name: string; text: string };

export function buildContent(text: string, attachments: Attachment[]): string | ContentPart[] {
	let full = text;
	for (const a of attachments) if (a.kind === "file") full += `\n\n<<<archivo: ${a.name}>>>\n${a.text}\n<<<fin del archivo>>>`;
	const images = attachments.filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image");
	if (!images.length) return full.trim();
	return [{ type: "text", text: full.trim() || "¿Qué hay en esta imagen?" }, ...images.map((a) => ({ type: "image_url" as const, image_url: { url: a.dataUrl } }))];
}

const FILE_BLOCK = /\n*<<<archivo: ([^>\n]+)>>>\n[\s\S]*?\n<<<fin del archivo>>>/g;

/** Para pintar un mensaje: el texto sin los archivos, los nombres de los archivos y las imágenes. */
export function splitContent(content: string | ContentPart[]): { text: string; files: string[]; images: string[] } {
	const raw = typeof content === "string" ? content : content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
	const images = typeof content === "string" ? [] : content.filter((p) => p.type === "image_url").map((p) => (p as { image_url: { url: string } }).image_url.url);
	const files: string[] = [];
	const text = raw.replace(FILE_BLOCK, (_, name: string) => (files.push(name), "")).trim();
	return { text, files, images };
}

/** Cambia el texto de un mensaje y conserva sus archivos e imágenes (editar en la web hace lo mismo). */
export function replaceText(content: string | ContentPart[], newText: string): string | ContentPart[] {
	const raw = typeof content === "string" ? content : content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
	const blocks = (raw.match(FILE_BLOCK) ?? []).join("");
	if (typeof content === "string") return (newText + blocks).trim();
	const images = content.filter((p) => p.type === "image_url");
	return [{ type: "text", text: (newText + blocks).trim() || "¿Qué hay en esta imagen?" }, ...images];
}

/** El base64 de una imagen en data URL (lo que pide Ollama en `images`). */
export const base64Of = (dataUrl: string) => dataUrl.replace(/^data:[^,]*base64,/, "");
