/**
 * Texto normalizado para comparar nombres de agentes y frases del usuario:
 * sin tildes ni mayúsculas, la puntuación pasa a espacios ("¿Qué opinas, Lúnes?" → "que opinas lunes").
 * `keepAt` deja la @ de las menciones ("@lunes").
 */
export function normalizeText(s: string, keepAt = false): string {
	return s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(keepAt ? /[^\p{L}\p{N}@]+/gu : /[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

export function normalizeName(s: string): string {
	return normalizeText(s);
}

export function tokenize(s: string, keepAt = false): string[] {
	const n = normalizeText(s, keepAt);
	return n ? n.split(" ") : [];
}

/** "Señor Lunes" → "senor-lunes". */
export function slugify(s: string): string {
	return normalizeName(s).replace(/ /g, "-").slice(0, 40).replace(/-+$/, "");
}
