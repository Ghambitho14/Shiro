import type { LLMProvider } from "../../config/config.js";
import { listGgufModels } from "../llamacpp/models.js";
import { catalogModels, ensureCatalog } from "./catalog.js";
import { PROVIDER_PRESETS, normalizeBaseUrl, resolveLLMSettings } from "./providers.js";

export type ModelOption = {
	id: string;
	/** Nombre bonito, si el proveedor lo da ("Kimi K2.6"). */
	name?: string;
	/** Ya está en memoria (LM Studio y Ollama lo dicen): responde sin esperar a cargarlo. */
	loaded?: boolean;
};
export type ModelList = { models: ModelOption[]; error?: string };

/**
 * Modelos que ofrece un proveedor, para elegirlos de una lista en vez de escribirlos.
 * Sirve también antes de guardar: Ajustes → Modelo pregunta por el proveedor y la dirección
 * que hay en el formulario. Nunca lanza: si no se puede, devuelve la lista vacía y el motivo.
 */
export async function listProviderModels(opts: { provider: LLMProvider; baseUrl?: string; apiKey?: string }): Promise<ModelList> {
	const { provider } = opts;
	const preset = PROVIDER_PRESETS[provider];
	if (preset.managed) return { models: listGgufModels().map((m) => ({ id: m.id })) };

	const saved = resolveLLMSettings();
	const sameProvider = saved.provider === provider;
	const base = normalizeBaseUrl(opts.baseUrl?.trim() || (sameProvider ? saved.baseUrl : preset.baseUrl), preset.dialect);
	try {
		if (!/^https?:$/.test(new URL(base).protocol)) throw new Error();
	} catch {
		return { models: [], error: `La dirección "${base}" no es válida. Tiene que empezar por http:// o https://.` };
	}
	// La clave guardada solo va a la dirección guardada: nunca a otra que se haya escrito en el formulario.
	const apiKey =
		opts.apiKey?.trim() ||
		(sameProvider && saved.baseUrl === base ? saved.apiKey : "") ||
		(preset.apiKeyEnv ? process.env[preset.apiKeyEnv]?.trim() : "") ||
		"";

	// OpenCode: el catálogo de models.dev ya dice qué modelos hay, sin clave.
	if (preset.catalog) {
		await ensureCatalog();
		const known = catalogModels(preset.catalog);
		if (known && Object.keys(known).length) {
			const models = Object.entries(known)
				.filter(([, m]) => !m.deprecated)
				.map(([id, m]) => ({ id, ...(m.name && m.name !== id ? { name: m.name } : {}) }));
			return { models: sortModels(models) };
		}
	}

	// "Otro servidor" no tiene nombre propio: en los mensajes es "el servidor".
	const who = provider === "custom" ? "el servidor" : preset.title;
	const Who = who[0].toUpperCase() + who.slice(1);
	const url = preset.dialect === "ollama" ? `${base}/api/tags` : `${base}/models`;
	const headers: Record<string, string> = { ...preset.extraHeaders };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	let res: Response;
	try {
		res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		if (name === "TimeoutError" || name === "AbortError") return { models: [], error: `${Who} no contestó a tiempo (${base}).` };
		if (!preset.local) return { models: [], error: `No pude conectar con ${who}. ¿Tienes internet?` };
		const extra = provider === "lmstudio" ? " En LM Studio, enciende el servidor en la pestaña Developer." : "";
		return { models: [], error: `No encuentro ${who} en ${base}. ¿Está abierto?${extra}` };
	}
	if (res.status === 401 || res.status === 403) {
		return { models: [], error: apiKey ? `${Who} no acepta la API key. Revísala.` : `${Who} pide una API key.` };
	}
	if (res.status === 404) return { models: [], error: `En ${base} no encuentro la lista de modelos. ¿Es la dirección correcta?` };
	if (!res.ok) return { models: [], error: `${Who} respondió con un error (HTTP ${res.status}).` };
	let models: ModelOption[];
	try {
		models = parseModelList(await res.json());
	} catch {
		return { models: [], error: `Lo que contestó ${base} no es una lista de modelos. ¿Es la dirección correcta?` };
	}
	const loaded = await loadedModels(provider, base, headers);
	return { models: models.map((m) => (loaded.has(m.id) ? { ...m, loaded: true } : m)) };
}

/** Modelos que ya están cargados en memoria (Ollama: `/api/ps`; LM Studio: `/api/v0/models`). Vacío si no se sabe. */
async function loadedModels(provider: LLMProvider, base: string, headers: Record<string, string>): Promise<Set<string>> {
	try {
		const opts = { headers, signal: AbortSignal.timeout(3000) };
		if (provider === "ollama") {
			const j = (await (await fetch(`${base}/api/ps`, opts)).json()) as { models?: { name?: string }[] };
			return new Set((j.models ?? []).map((m) => String(m?.name ?? "")));
		}
		if (provider === "lmstudio") {
			const j = (await (await fetch(`${new URL(base).origin}/api/v0/models`, opts)).json()) as { data?: { id?: string; state?: string }[] };
			return new Set((j.data ?? []).filter((m) => m?.state === "loaded").map((m) => String(m.id)));
		}
	} catch {
		// Versión vieja o sin esa ruta: simplemente no se marca ninguno.
	}
	return new Set();
}

/**
 * Lee la lista de Ollama (`/api/tags`: models[].name) o la del formato OpenAI (`/models`: data[].id).
 * Quita los de embeddings (nomic-embed-text…): sirven para buscar, no para chatear.
 */
export function parseModelList(json: unknown): ModelOption[] {
	const j = (json ?? {}) as { models?: { name?: unknown }[]; data?: { id?: unknown; name?: unknown }[] };
	const raw: ModelOption[] = Array.isArray(j.models)
		? j.models.map((m) => ({ id: String(m?.name ?? "") }))
		: Array.isArray(j.data)
			? j.data.map((m) => ({ id: String(m?.id ?? ""), ...(typeof m?.name === "string" && m.name && m.name !== m.id ? { name: m.name } : {}) }))
			: [];
	const seen = new Set<string>();
	return sortModels(raw.filter((m) => m.id && !/embed/i.test(m.id) && !seen.has(m.id) && seen.add(m.id))).slice(0, 1000);
}

function sortModels(models: ModelOption[]): ModelOption[] {
	return models.sort((a, b) => a.id.localeCompare(b.id));
}
