/**
 * Ajustes de cada modelo (Ajustes → Modelo → "Ajustes de <modelo>"): cómo responde, contexto,
 * rendimiento de llama.cpp y herramientas. Prioridad: los propios del modelo
 * (config.modelSettings["<proveedor>|<modelo>"]) → los generales (campos sueltos de la
 * configuración, que ya existían) → los valores por defecto del schema.
 */
import { getConfig, modelTuningSchema, setConfig, type AppConfig, type LLMProvider, type ModelTuning } from "../../config/config.js";

/** Todos los ajustes ya resueltos para un modelo. */
export type EffectiveTuning = {
	/** undefined = la del modelo. */
	temperature?: number;
	thinking: "auto" | "on" | "off";
	/** undefined = sin límite. */
	maxTokens?: number;
	/** llama.cpp integrado: 0 = automático. Ollama: num_ctx. */
	contextSize: number;
	gpuLayers: "auto" | "all" | number;
	kvCache: "f16" | "q8_0" | "q4_0";
	threads: number;
	flashAttention: "auto" | "on" | "off";
	toolMode: "auto" | "native" | "text";
	toolProfile: "auto" | "lite" | "full";
	maxToolIterations: number;
	timeoutMs: number;
};

export const TUNING_KEYS = Object.keys(modelTuningSchema.shape) as (keyof ModelTuning)[];

/** Mismo formato que modelKey() de client.ts. */
export const tuningKey = (provider: LLMProvider, model: string) => `${provider}|${model}`;

/** El contexto general depende del proveedor: el automático de llama.cpp o el num_ctx de Ollama. */
const contextField = (provider: LLMProvider): "llamaContext" | "contextWindow" => (provider === "gguf" ? "llamaContext" : "contextWindow");

/** Los ajustes generales vistos como ajustes de modelo. */
export function generalTuning(provider: LLMProvider, cfg: AppConfig = getConfig()): EffectiveTuning {
	return {
		temperature: cfg.temperature,
		thinking: cfg.thinking,
		maxTokens: cfg.maxTokens,
		contextSize: cfg[contextField(provider)],
		gpuLayers: cfg.llamaGpuLayers,
		kvCache: cfg.llamaKvCache,
		threads: cfg.llamaThreads,
		flashAttention: cfg.llamaFlashAttention,
		toolMode: cfg.toolMode,
		toolProfile: cfg.toolProfile,
		maxToolIterations: cfg.maxToolIterations,
		timeoutMs: cfg.llmTimeoutMs,
	};
}

/** Los ajustes propios de un modelo (solo lo que cambia respecto a los generales), o null. */
export function ownTuning(provider: LLMProvider, model: string, cfg: AppConfig = getConfig()): ModelTuning | null {
	const own = cfg.modelSettings[tuningKey(provider, model)];
	if (!own) return null;
	const clean = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined)) as ModelTuning;
	return Object.keys(clean).length ? clean : null;
}

export function getModelTuning(provider: LLMProvider, model: string, cfg: AppConfig = getConfig()): EffectiveTuning {
	const out = generalTuning(provider, cfg);
	const own = ownTuning(provider, model, cfg) ?? {};
	for (const k of TUNING_KEYS) {
		if (own[k] !== undefined) (out as Record<string, unknown>)[k] = own[k];
	}
	// En Ollama 0 no significa nada: se usa el general.
	if (provider !== "gguf" && out.contextSize < 1024) out.contextSize = generalTuning(provider, cfg).contextSize;
	return out;
}

/** Valida lo que llega de la web. `null` en un campo = "el valor por defecto" (se quita). */
export function parseTuningInput(input: unknown): ModelTuning {
	const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	const cleaned = Object.fromEntries(Object.entries(raw).filter(([k, v]) => TUNING_KEYS.includes(k as keyof ModelTuning) && v !== null && v !== ""));
	return modelTuningSchema.parse(cleaned);
}

/**
 * Guarda los ajustes de un modelo. Solo se guarda lo que difiere de los generales: así, si luego
 * cambian los generales, el modelo los sigue en todo lo que no se tocó. null = volver a los generales.
 */
export function setModelTuning(provider: LLMProvider, model: string, values: ModelTuning | null): ModelTuning | null {
	const cfg = getConfig();
	const all = { ...cfg.modelSettings };
	const key = tuningKey(provider, model);
	const general = generalTuning(provider, cfg);
	const diff: ModelTuning = {};
	for (const k of TUNING_KEYS) {
		const v = values?.[k];
		if (v !== undefined && v !== general[k]) (diff as Record<string, unknown>)[k] = v;
	}
	if (Object.keys(diff).length) all[key] = diff;
	else delete all[key];
	setConfig({ modelSettings: all });
	return Object.keys(diff).length ? diff : null;
}

/** Guarda los ajustes generales (para todos los modelos que no tengan los suyos). */
export function setGeneralTuning(provider: LLMProvider, values: ModelTuning): void {
	const patch: Partial<AppConfig> = {
		// Los que se pueden dejar "sin valor" (la temperatura del modelo, sin límite) se borran si no vienen.
		temperature: values.temperature,
		maxTokens: values.maxTokens,
	};
	if (values.thinking) patch.thinking = values.thinking;
	if (values.contextSize !== undefined) {
		if (provider === "gguf") patch.llamaContext = values.contextSize;
		else if (values.contextSize >= 1024) patch.contextWindow = values.contextSize;
	}
	if (values.gpuLayers !== undefined) patch.llamaGpuLayers = values.gpuLayers;
	if (values.kvCache) patch.llamaKvCache = values.kvCache;
	if (values.threads !== undefined) patch.llamaThreads = values.threads;
	if (values.flashAttention) patch.llamaFlashAttention = values.flashAttention;
	if (values.toolMode) patch.toolMode = values.toolMode;
	if (values.toolProfile) patch.toolProfile = values.toolProfile;
	if (values.maxToolIterations !== undefined) patch.maxToolIterations = values.maxToolIterations;
	if (values.timeoutMs !== undefined) patch.llmTimeoutMs = values.timeoutMs;
	setConfig(patch);
}
