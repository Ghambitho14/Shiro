/**
 * Cuánto contexto tiene el modelo (para el medidor de la caja de escribir). Nunca lanza:
 * si el proveedor no lo dice, devuelve undefined y la web muestra solo los tokens.
 * - Ollama de este equipo y llama.cpp integrado: lo fija o lo sabe Shiro (`contextWindow`).
 * - OpenCode: el catálogo de models.dev.
 * - LM Studio: el contexto con el que está cargado el modelo (`/api/v0/models`).
 * - llama.cpp propio: `/props`. Ollama Cloud: `/api/show`.
 * - OpenRouter, vLLM y otros servidores: la lista `/models` (context_length, max_model_len…).
 */
import { lookupModel, resolveModelId } from "./catalog.js";
import { PROVIDER_PRESETS, type LLMSettings } from "./providers.js";

/** Los locales pueden recargar el modelo con otro contexto: se vuelven a mirar pronto. */
const LOCAL_TTL_MS = 30_000;
const CLOUD_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 4000;

const cache = new Map<string, { value: number | undefined; at: number }>();

const positive = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

export async function contextLimit(s: LLMSettings): Promise<number | undefined> {
	const preset = PROVIDER_PRESETS[s.provider];
	if (preset.managed || (s.dialect === "ollama" && s.local)) return positive(s.contextWindow);
	if (preset.catalog) return positive(lookupModel(preset.catalog, resolveModelId(preset.catalog, s.model))?.context);

	const key = `${s.provider}|${s.baseUrl}|${s.model}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < (s.local ? LOCAL_TTL_MS : CLOUD_TTL_MS)) return hit.value;
	let value: number | undefined;
	try {
		value = await fetchLimit(s);
	} catch {
		value = undefined;
	}
	cache.set(key, { value, at: Date.now() });
	return value;
}

/** Para las pruebas. */
export function clearContextLimitCache(): void {
	cache.clear();
}

async function getJson(url: string, s: LLMSettings, init: RequestInit = {}): Promise<unknown> {
	const res = await fetch(url, {
		...init,
		headers: { ...s.headers, ...(init.body ? { "Content-Type": "application/json" } : {}) },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return res.json();
}

async function fetchLimit(s: LLMSettings): Promise<number | undefined> {
	const origin = new URL(s.baseUrl).origin;
	if (s.provider === "lmstudio") {
		// Por la lista y no por /models/<id>: los ids llevan "/" (qwen/qwen3.6-35b-a3b).
		const j = (await getJson(`${origin}/api/v0/models`, s)) as { data?: { id?: unknown; state?: unknown; loaded_context_length?: unknown }[] };
		const m = j.data?.find((x) => x?.id === s.model);
		// Sin cargar no se sabe con qué contexto lo abrirá LM Studio.
		return m?.state === "loaded" ? positive(m.loaded_context_length) : undefined;
	}
	if (s.provider === "llamacpp") {
		const j = (await getJson(`${origin}/props`, s)) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
		return positive(j.default_generation_settings?.n_ctx ?? j.n_ctx);
	}
	if (s.dialect === "ollama") {
		const j = (await getJson(`${s.baseUrl}/api/show`, s, { method: "POST", body: JSON.stringify({ model: s.model }) })) as {
			model_info?: Record<string, unknown>;
		};
		const key = Object.keys(j.model_info ?? {}).find((k) => k.endsWith(".context_length"));
		return key ? positive(j.model_info![key]) : undefined;
	}
	if (s.dialect === "anthropic") return undefined;
	const j = (await getJson(`${s.baseUrl}/models`, s)) as { data?: Record<string, unknown>[] };
	const m = j.data?.find((x) => x?.id === s.model);
	if (!m) return undefined;
	const top = m.top_provider as { context_length?: unknown } | undefined;
	return positive(m.context_length ?? m.max_model_len ?? m.context_window ?? top?.context_length);
}
