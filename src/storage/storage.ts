/**
 * Dónde guarda Shiro las cosas del usuario (chats, recuerdos, recordatorios y notas de memoria).
 * Se elige en la bienvenida o en Ajustes → Datos; vive en data/config.json (storage, obsidianVault,
 * supabaseUrl, supabaseKey). Los ajustes, las claves y las sesiones de WhatsApp/navegador siempre
 * se quedan en este equipo.
 */
import { existsSync } from "node:fs";
import { getConfig, type StorageKind } from "../config/config.js";
import { checkVault } from "./obsidian.js";
import { normalizeSupabaseUrl, testSupabase, type SupabaseConfig } from "./supabase.js";

export type StorageSettings = { kind: StorageKind; obsidianVault?: string; supabaseUrl?: string; supabaseKey?: string };

export const STORAGE_LABELS: Record<StorageKind, string> = { local: "este equipo", obsidian: "Obsidian", supabase: "Supabase" };

export function currentStorage(): StorageSettings {
	const c = getConfig();
	return { kind: c.storage, obsidianVault: c.obsidianVault, supabaseUrl: c.supabaseUrl, supabaseKey: c.supabaseKey };
}

export class StorageConfigError extends Error {}

/** Conexión de Supabase de unos ajustes (error claro si falta algo). */
export function supabaseOf(s: StorageSettings): SupabaseConfig {
	if (!s.supabaseUrl || !s.supabaseKey) throw new StorageConfigError("Falta la dirección o la clave de Supabase: complétalas en Ajustes → Datos.");
	return { url: normalizeSupabaseUrl(s.supabaseUrl), key: s.supabaseKey };
}

/** Bóveda de Obsidian de unos ajustes (error claro si falta o ya no existe). */
export function vaultOf(s: StorageSettings): string {
	if (!s.obsidianVault) throw new StorageConfigError("Falta la carpeta de tu bóveda de Obsidian: elígela en Ajustes → Datos.");
	if (!existsSync(s.obsidianVault)) throw new StorageConfigError(`No encuentro tu bóveda de Obsidian (${s.obsidianVault}). Cámbiala en Ajustes → Datos.`);
	return s.obsidianVault;
}

export type StorageTest = { ok: true; warning?: string } | { ok: false; error: string; missingTables?: boolean };

/** Comprueba unos ajustes antes de guardarlos. */
export async function testStorage(s: StorageSettings): Promise<StorageTest> {
	if (s.kind === "local") return { ok: true };
	if (s.kind === "obsidian") return checkVault(s.obsidianVault ?? "");
	if (!s.supabaseUrl) return { ok: false, error: "Falta la dirección de tu proyecto de Supabase (https://xxxx.supabase.co)." };
	return testSupabase({ url: s.supabaseUrl, key: s.supabaseKey ?? "" });
}
