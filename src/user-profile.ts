import { readProfile, writeProfile } from "./workspace.js";

/**
 * «Sobre ti» (Ajustes → Personalización). Vive en la nota «Sobre mí.md» de la memoria (con Obsidian,
 * en la carpeta Shiro de la bóveda) y se lee cada vez: lo que se cambie en Obsidian vale al momento.
 */
export type UserProfile = {
	/** Nombre de la persona que usa Shiro */
	userName?: string;
	/** Idioma preferido (ej. español, inglés) */
	language?: string;
	/** Lo que Shiro debe saber sobre ti: aficiones, trabajo, preferencias */
	about?: string;
	/** Cómo quieres que responda */
	extra?: string;
};

export function getUserProfile(): UserProfile {
	return readProfile();
}

export function setUserProfile(partial: Partial<UserProfile>): UserProfile {
	const current = getUserProfile();
	const pick = (value: string | undefined, old: string | undefined) => (value !== undefined ? value.trim() || undefined : old);
	const next: UserProfile = {
		userName: pick(partial.userName, current.userName),
		language: pick(partial.language, current.language),
		about: pick(partial.about, current.about),
		extra: pick(partial.extra, current.extra),
	};
	writeProfile(next);
	return next;
}
