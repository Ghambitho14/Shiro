import { getConfig, type LLMProvider } from "../../config/config.js";
import { ensureCatalog, guessApi, lookupModel, resolveModelId, type CatalogId } from "./catalog.js";
import { LLMError } from "./LLMClient.js";
import { currentLlamaServer, ensureLlamaServer } from "../llamacpp/engine.js";
import { findGgufModel } from "../llamacpp/models.js";
import { getModelTuning, type EffectiveTuning } from "./modelSettings.js";

/**
 * Cómo se habla con el modelo:
 * - openai: /chat/completions (el más común)
 * - ollama: /api/chat nativo (única forma de fijar num_ctx por petición)
 * - anthropic: /messages (Claude; en OpenCode también MiniMax y algunos Qwen)
 * - responses: /responses (GPT, Grok y Muse en OpenCode)
 */
export type Dialect = "openai" | "ollama" | "anthropic" | "responses";

/**
 * Presets de proveedores. Casi todos hablan "OpenAI chat completions".
 * En OpenCode (Zen y Go) el formato depende del modelo: se mira en el catálogo.
 */
export type ProviderPreset = {
	label: string;
	/** Nombre corto de la tarjeta en Ajustes → Modelo (el grupo ya dice si es local o de la nube). */
	title: string;
	/** Una frase sencilla que explica para qué sirve. */
	hint: string;
	/** Dónde sale en Ajustes → Modelo: "En tu PC", "En la nube" o "Más opciones". */
	group: "pc" | "cloud" | "advanced";
	dialect: Dialect;
	baseUrl: string;
	model: string;
	local: boolean;
	needsApiKey: boolean;
	/** Variable de entorno que puede traer la API key. */
	apiKeyEnv?: string;
	extraHeaders?: Record<string, string>;
	/** Catálogo de models.dev con el formato y las capacidades de cada modelo. */
	catalog?: CatalogId;
	/** Página donde el usuario copia su API key. */
	keyUrl?: string;
	/** Shiro abre y cierra el servidor él mismo (llama.cpp integrado): no hay dirección ni clave que poner. */
	managed?: boolean;
};

export const PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset> = {
	ollama: {
		label: "Ollama (local)",
		title: "Ollama",
		hint: "Si ya usas Ollama. Tiene que estar abierto.",
		group: "pc",
		dialect: "ollama",
		baseUrl: "http://localhost:11434",
		model: "qwen3:8b",
		local: true,
		needsApiKey: false,
	},
	lmstudio: {
		label: "LM Studio (local)",
		title: "LM Studio",
		hint: "Si ya usas LM Studio. Enciende su servidor local (pestaña Developer).",
		group: "pc",
		dialect: "openai",
		baseUrl: "http://localhost:1234/v1",
		model: "local-model",
		local: true,
		needsApiKey: false,
	},
	llamacpp: {
		label: "llama.cpp server (local)",
		title: "llama.cpp server",
		hint: "Solo si abres llama-server tú mismo. Si no, usa «Archivos GGUF», que hace lo mismo solo.",
		group: "advanced",
		dialect: "openai",
		baseUrl: "http://localhost:8080/v1",
		model: "local-model",
		local: true,
		needsApiKey: false,
	},
	gguf: {
		label: "llama.cpp integrado (archivos GGUF)",
		title: "Archivos GGUF",
		hint: "Lo más fácil: Shiro abre el modelo él solo, sin instalar nada más. Usa los que ya bajaste con LM Studio u Ollama.",
		group: "pc",
		dialect: "openai",
		// La de verdad la pone el motor al arrancar (puerto libre): ver currentLlamaServer().
		baseUrl: "http://127.0.0.1/v1",
		model: "",
		local: true,
		needsApiKey: false,
		managed: true,
	},
	vllm: {
		label: "vLLM (local/servidor)",
		title: "vLLM",
		hint: "Un servidor vLLM en este equipo o en otro de tu red.",
		group: "advanced",
		dialect: "openai",
		baseUrl: "http://127.0.0.1:8000/v1",
		model: "default",
		local: true,
		needsApiKey: false,
		apiKeyEnv: "VLLM_API_KEY",
	},
	"ollama-cloud": {
		label: "Ollama Cloud (nube)",
		title: "Ollama Cloud",
		hint: "Los modelos grandes de Ollama en sus servidores, con tu cuenta de ollama.com. No necesitas GPU ni tener Ollama abierto.",
		group: "cloud",
		dialect: "ollama",
		baseUrl: "https://ollama.com",
		model: "gpt-oss:120b",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OLLAMA_API_KEY",
		keyUrl: "https://ollama.com/settings/keys",
	},
	openrouter: {
		label: "OpenRouter (nube)",
		title: "OpenRouter",
		hint: "Cientos de modelos de varias empresas con una sola cuenta.",
		group: "cloud",
		dialect: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "openai/gpt-4o-mini",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OPENROUTER_API_KEY",
		keyUrl: "https://openrouter.ai/keys",
		extraHeaders: { "HTTP-Referer": "https://github.com/Ghambitho14/Shiro", "X-Title": "Shiro" },
	},
	opencode: {
		label: "OpenCode Zen (nube)",
		title: "OpenCode Zen",
		hint: "Los modelos de OpenCode: pagas solo lo que usas.",
		group: "cloud",
		dialect: "openai",
		baseUrl: "https://opencode.ai/zen/v1",
		model: "kimi-k2.6",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OPENCODE_API_KEY",
		catalog: "opencode",
		keyUrl: "https://opencode.ai/auth",
	},
	"opencode-go": {
		label: "OpenCode Go (suscripción)",
		title: "OpenCode Go",
		hint: "Suscripción mensual de OpenCode con modelos abiertos.",
		group: "cloud",
		dialect: "openai",
		baseUrl: "https://opencode.ai/zen/go/v1",
		model: "glm-5.3-flash",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OPENCODE_API_KEY",
		catalog: "opencode-go",
		keyUrl: "https://opencode.ai/auth",
	},
	custom: {
		label: "Otro servidor compatible con OpenAI",
		title: "Otro servidor",
		hint: "Cualquier programa compatible con la API de OpenAI (escribe su dirección).",
		group: "advanced",
		dialect: "openai",
		baseUrl: "http://localhost:8000/v1",
		model: "default",
		local: true,
		needsApiKey: false,
	},
};

export type LLMSettings = {
	provider: LLMProvider;
	dialect: Dialect;
	baseUrl: string;
	model: string;
	apiKey: string;
	local: boolean;
	headers: Record<string, string>;
	contextWindow: number;
	timeoutMs: number;
	temperature?: number;
	toolMode: "auto" | "native" | "text";
	/** Máximo de tokens de salida del modelo, si se conoce (el formato Anthropic obliga a indicarlo). */
	maxOutputTokens?: number;
	/** Largo máximo de respuesta elegido por el usuario (Ajustes → Modelo). */
	maxTokens?: number;
	/** Pensar antes de responder (solo se envía a modelos locales; sin valor o "auto" = lo que diga el modelo). */
	thinking?: "auto" | "on" | "off";
	/** Si tiene texto, el modelo no se puede usar desde Shiro y este es el motivo. */
	unsupported?: string;
};

export function normalizeBaseUrl(url: string, dialect: Dialect): string {
	let u = url.trim().replace(/\/+$/, "");
	if (dialect === "ollama") {
		// Aceptar tanto http://host:11434 como http://host:11434/v1 o /api.
		u = u.replace(/\/(v1|api)$/i, "");
	}
	return u;
}

/**
 * Resuelve la configuración efectiva del modelo.
 * Prioridad: variables de entorno SHIRO_LLM_* > data/config.json > preset.
 */
export function currentProvider(): LLMProvider {
	const envProvider = process.env.SHIRO_LLM_PROVIDER?.trim() as LLMProvider | undefined;
	return envProvider && envProvider in PROVIDER_PRESETS ? envProvider : getConfig().llmProvider;
}

/** En OpenCode los modelos se escriben "opencode-go/kimi-k3"; la API solo quiere "kimi-k3". */
function stripProviderPrefix(model: string): string {
	return model.replace(/^opencode(-go)?\//i, "");
}

export function configuredModel(): string {
	return process.env.SHIRO_LLM_MODEL?.trim() || getConfig().llmModel || PROVIDER_PRESETS[currentProvider()].model;
}

/**
 * Un modelo distinto del de Ajustes → Modelo (el de un agente). Sin ref, todo usa el de Ajustes.
 * - Mismo proveedor que en Ajustes: su dirección y su API key.
 * - Otro proveedor: `baseUrl` o la dirección del preset, y la clave de su variable de entorno.
 */
export type ModelRef = { provider: LLMProvider; model?: string; baseUrl?: string };

function refProvider(ref?: ModelRef): LLMProvider {
	return ref && ref.provider in PROVIDER_PRESETS ? ref.provider : currentProvider();
}

function refModel(ref?: ModelRef): string {
	if (!ref || !(ref.provider in PROVIDER_PRESETS)) return configuredModel();
	if (ref.model?.trim()) return ref.model.trim();
	return ref.provider === currentProvider() ? configuredModel() : PROVIDER_PRESETS[ref.provider].model;
}

/**
 * Deja listo lo que resolveLLMSettings() necesita y no puede esperar por ser síncrona:
 * el catálogo de modelos de OpenCode, o el llama.cpp integrado con el modelo cargado.
 */
export async function prepareLLM(signal?: AbortSignal, ref?: ModelRef): Promise<void> {
	const preset = PROVIDER_PRESETS[refProvider(ref)];
	if (preset.catalog) await ensureCatalog();
	if (preset.managed) {
		const wanted = refModel(ref);
		if (!wanted) throw new LLMError("Elige un modelo GGUF en Ajustes → Modelo.", "bad_request");
		const model = findGgufModel(wanted);
		if (!model) {
			throw new LLMError(
				`No encuentro el modelo "${wanted}" en este equipo. Elige otro en Ajustes → Modelo (se buscan en LM Studio, Ollama, data/models y tus carpetas).`,
				"model_not_found",
			);
		}
		await ensureLlamaServer(model, signal);
	}
}

export function resolveLLMSettings(ref?: ModelRef): LLMSettings {
	const cfg = getConfig();
	const env = process.env;
	const provider = refProvider(ref);
	const preset = PROVIDER_PRESETS[provider];
	// La dirección y la clave de Ajustes solo valen para el proveedor de Ajustes.
	const sameProvider = provider === currentProvider();

	// llama.cpp integrado: la dirección y la clave las pone el motor (cambian en cada arranque).
	const engine = preset.managed ? currentLlamaServer() : null;
	const baseUrl = preset.managed
		? (engine?.baseUrl ?? preset.baseUrl)
		: normalizeBaseUrl(
				ref?.baseUrl?.trim() || (sameProvider ? env.SHIRO_LLM_BASE_URL?.trim() || cfg.llmBaseUrl : "") || preset.baseUrl,
				preset.dialect,
			);
	let model = refModel(ref);
	const presetKey = (preset.apiKeyEnv ? env[preset.apiKeyEnv]?.trim() : "") || "";
	const apiKey = preset.managed ? "" : sameProvider ? env.SHIRO_LLM_API_KEY?.trim() || cfg.llmApiKey || presetKey : presetKey;

	let dialect = preset.dialect;
	/** Algunos modelos de la nube no aceptan temperatura (lo dice el catálogo). */
	let acceptsTemperature = true;
	let maxOutputTokens: number | undefined;
	let unsupported: string | undefined;
	if (preset.catalog) {
		model = resolveModelId(preset.catalog, stripProviderPrefix(model));
		const info = lookupModel(preset.catalog, model);
		const api = info?.api ?? guessApi(preset.catalog, model);
		if (api === "google") {
			unsupported = `El modelo "${model}" usa el formato de Google, que Shiro todavía no habla. Elige otro modelo de ${preset.label}.`;
		} else {
			dialect = api === "messages" ? "anthropic" : api === "responses" ? "responses" : "openai";
		}
		if (info && !info.temperature) acceptsTemperature = false;
		maxOutputTokens = info?.output;
	}

	// Ajustes de este modelo (o los generales): Ajustes → Modelo → "Ajustes de <modelo>".
	const tuning = getModelTuning(provider, model, cfg);
	const temperature = acceptsTemperature ? tuning.temperature : undefined;

	const headers: Record<string, string> = { "Content-Type": "application/json", ...preset.extraHeaders };
	if (dialect === "anthropic") {
		// El formato Anthropic no usa "Authorization: Bearer": la clave va en x-api-key.
		headers["anthropic-version"] = "2023-06-01";
		if (apiKey) headers["x-api-key"] = apiKey;
	} else if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	} else if (engine) {
		headers.Authorization = `Bearer ${engine.apiKey}`;
	}

	return {
		provider,
		dialect,
		baseUrl,
		model,
		apiKey,
		local: preset.local,
		headers,
		// llama.cpp integrado: el contexto real del servidor (en automático lo elige llama.cpp).
		contextWindow: preset.managed ? (engine?.ctx ?? tuning.contextSize) : tuning.contextSize,
		timeoutMs: tuning.timeoutMs,
		temperature,
		toolMode: tuning.toolMode,
		maxOutputTokens,
		maxTokens: tuning.maxTokens,
		thinking: tuning.thinking,
		unsupported,
	};
}

/** Ajustes del modelo que se está usando ahora (o el de `ref`): perfil de herramientas, pasos… */
export function activeModelTuning(ref?: ModelRef): EffectiveTuning {
	const s = resolveLLMSettings(ref);
	return getModelTuning(s.provider, s.model);
}

/** Nombres de modelos que aceptan imágenes (visión). */
const VISION_MODEL =
	/(vision|llava|bakllava|[-_.:]vl\b|qwen2\.5vl|qwen3-?vl|gemma-?3|minicpm-v|moondream|pixtral|mistral-small-?3\.[12]|gpt-4o|gpt-4\.1|gpt-5|\bo[34]\b|claude|gemini|grok-4|llama-?4|kimi-k2\.5|glm-4\.5v|glm-4v)/i;

/** ¿Puede el modelo ver imágenes? Con `vision: "auto"` se mira el catálogo (OpenCode) o se deduce del nombre. */
export function modelSupportsVision(
	model: string,
	setting: "auto" | "on" | "off" = getConfig().vision,
	provider: LLMProvider = currentProvider(),
): boolean {
	if (setting === "on") return true;
	if (setting === "off") return false;
	const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS[currentProvider()];
	// llama.cpp integrado: ve imágenes si el modelo trae su proyector de visión (mmproj).
	if (preset.managed) {
		const found = findGgufModel(model);
		if (found) return Boolean(found.mmproj);
	}
	const catalog = preset.catalog;
	const known = catalog ? lookupModel(catalog, stripProviderPrefix(model)) : undefined;
	return known ? known.vision : VISION_MODEL.test(model);
}

/** API key enmascarada para mostrar en pantalla o logs. */
export function maskKey(key: string): string {
	return key ? `***${key.slice(-4)}` : "";
}
