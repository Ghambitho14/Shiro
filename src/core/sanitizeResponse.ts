/**
 * Elimina bloques <think>...</think> del output del modelo.
 * Devuelve solo el texto final para el usuario.
 */
export function sanitizeModelResponse(content: string): string {
	if (!content || typeof content !== "string") return content;
	let out = content.trim();
	// Eliminar bloque <think> al inicio
	const thinkMatch = out.match(/^\s*<think>[\s\S]*?<\/think>/i);
	if (thinkMatch) {
		out = out.slice(thinkMatch[0].length).replace(/^\s*\n?/, "");
	}
	// Por si el modelo pone <think> en medio: quitar todo entre <think> y </think>
	out = out.replace(/\s*<think>[\s\S]*?<\/think>\s*/gi, " ").trim();
	return out || content.trim();
}
