import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PROFILE_FILE = join(DATA_DIR, "user-profile.json");

export type UserProfile = {
	/** Nombre de la persona que usa Shiro */
	userName?: string;
	/** Idioma preferido (ej. español, inglés) */
	language?: string;
	/** Lo que Shiro debe saber sobre ti: aficiones, trabajo, preferencias */
	about?: string;
	/** Notas extra que quieras que Shiro recuerde */
	extra?: string;
};

const DEFAULTS: UserProfile = {
	userName: undefined,
	language: undefined,
	about: undefined,
	extra: undefined,
};

function loadProfile(): UserProfile {
	if (!existsSync(PROFILE_FILE)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(PROFILE_FILE, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return {
			userName: typeof data.userName === "string" ? data.userName.trim() || undefined : DEFAULTS.userName,
			language: typeof data.language === "string" ? data.language.trim() || undefined : DEFAULTS.language,
			about: typeof data.about === "string" ? data.about.trim() || undefined : DEFAULTS.about,
			extra: typeof data.extra === "string" ? data.extra.trim() || undefined : DEFAULTS.extra,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

let cached: UserProfile | null = null;

export function getUserProfile(): UserProfile {
	if (cached === null) cached = loadProfile();
	return { ...cached };
}

export function setUserProfile(partial: Partial<UserProfile>): UserProfile {
	const current = getUserProfile();
	const next: UserProfile = {
		userName: partial.userName !== undefined ? (partial.userName.trim() || undefined) : current.userName,
		language: partial.language !== undefined ? (partial.language.trim() || undefined) : current.language,
		about: partial.about !== undefined ? (partial.about.trim() || undefined) : current.about,
		extra: partial.extra !== undefined ? (partial.extra.trim() || undefined) : current.extra,
	};
	cached = next;
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(PROFILE_FILE, JSON.stringify(next, null, 2), "utf-8");
	return next;
}

/** Texto para inyectar en el contexto del agente (vacío si no hay perfil útil). */
export function getUserProfileContext(profile: UserProfile): string {
	const parts: string[] = [];
	if (profile.userName) parts.push(`Nombre: ${profile.userName}`);
	if (profile.language) parts.push(`Idioma preferido: ${profile.language}`);
	if (profile.about) parts.push(`Sobre la persona: ${profile.about}`);
	if (profile.extra) parts.push(`Notas: ${profile.extra}`);
	if (parts.length === 0) return "";
	return "## Sobre el usuario\n" + parts.join("\n");
}
