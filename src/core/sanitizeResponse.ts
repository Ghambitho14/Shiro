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

/** Respuesta por defecto cuando el modelo no da una respuesta útil (vacía o genérica). */
export const FALLBACK_EMPTY_RESPONSE = "No pude generar una respuesta útil. ¿Puedes reformular o dar más detalles?";

const MIN_MEANINGFUL_LENGTH = 3;
/** Frases que se consideran no útiles como respuesta final (regex, case-insensitive). */
const GENERIC_PHRASES = [
	/^listo\.?$/i,
	/^ok\.?$/i,
	/^listo\,?\s*$/i,
	/^ok\,?\s*$/i,
	/^listo\s*\.\s*$/i,
	/^sin respuesta de texto\.?$/i,
	/^\(sin respuesta de texto\)\.?$/i,
];

/**
 * Indica si el texto es una respuesta final aceptable para mostrar al usuario.
 * Evita devolver respuestas vacías o genéricas ("Listo.", "Ok.", "(Sin respuesta de texto)").
 */
export function isMeaningfulResponse(text: string): boolean {
	if (!text || typeof text !== "string") return false;
	const t = text.trim();
	if (t.length < MIN_MEANINGFUL_LENGTH) return false;
	if (GENERIC_PHRASES.some((re) => re.test(t))) return false;
	return true;
}
