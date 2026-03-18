import type { ContentPart, UserContent } from "./Types.js";

/** Extrae texto de un contenido (string o partes) para título, preview o goal. */
export function getMessagePreview(content: UserContent): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content) || content.length === 0) return "";
	const texts = content
		.filter((p): p is ContentPart => p && typeof p === "object" && (p as ContentPart).type === "text")
		.map((p) => (p as { type: "text"; text: string }).text.trim())
		.filter(Boolean);
	if (texts.length === 0) return "[imagen]";
	return texts.join(" ");
}
