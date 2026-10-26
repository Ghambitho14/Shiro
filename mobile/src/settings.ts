/**
 * Ajustes de la app. En el teléfono van en el almacén cifrado del sistema (expo-secure-store);
 * en el navegador (solo para probar) en localStorage.
 */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_SETTINGS, type AppSettings } from "./core/types";

const KEY = "shiro_settings";

export async function loadSettings(): Promise<AppSettings> {
	try {
		const raw = Platform.OS === "web" ? globalThis.localStorage?.getItem(KEY) : await SecureStore.getItemAsync(KEY);
		return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) } : { ...DEFAULT_SETTINGS };
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(s: AppSettings): Promise<void> {
	const raw = JSON.stringify(s);
	if (Platform.OS === "web") globalThis.localStorage?.setItem(KEY, raw);
	else await SecureStore.setItemAsync(KEY, raw);
}

export const isConfigured = (s: AppSettings) => Boolean(s.supabaseUrl.trim() && s.supabaseKey.trim() && s.ollamaKey.trim() && s.model.trim());
