import { getConfig, type LLMProvider } from "../../config/config.js";

/**
 * Presets de proveedores. Todos hablan el formato "OpenAI chat completions",
 * excepto Ollama, que usa su API nativa (/api/chat) porque es la única forma
 * de fijar el tamaño de contexto (num_ctx) por petición.
 */
export type ProviderPreset = {
	label: string;
	dialect: "openai" | "ollama";
	baseUrl: string;
	model: string;
	local: boolean;
	needsApiKey: boolean;
	/** Variable de entorno que puede traer la API key. */
	apiKeyEnv?: string;
	extraHeaders?: Record<string, string>;
};

export const PROVIDER_PRESETS: Record<LLMProvider, ProviderPreset> = {
	ollama: {
		label: "Ollama (local)",
		dialect: "ollama",
		baseUrl: "http://localhost:11434",
		model: "qwen3:8b",
		local: true,
		needsApiKey: false,
	},
	lmstudio: {
		label: "LM Studio (local)",
		dialect: "openai",
		baseUrl: "http://localhost:1234/v1",
		model: "local-model",
		local: true,
		needsApiKey: false,
	},
	llamacpp: {
		label: "llama.cpp server (local)",
		dialect: "openai",
		baseUrl: "http://localhost:8080/v1",
		model: "local-model",
		local: true,
		needsApiKey: false,
	},
	vllm: {
		label: "vLLM (local/servidor)",
		dialect: "openai",
		baseUrl: "http://127.0.0.1:8000/v1",
		model: "default",
		local: true,
		needsApiKey: false,
		apiKeyEnv: "VLLM_API_KEY",
	},
	openrouter: {
		label: "OpenRouter (nube)",
		dialect: "openai",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "openai/gpt-4o-mini",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OPENROUTER_API_KEY",
		extraHeaders: { "HTTP-Referer": "https://github.com/Ghambitho14/Shiro", "X-Title": "Shiro" },
	},
	opencode: {
		label: "OpenCode Zen (nube)",
		dialect: "openai",
		baseUrl: "https://opencode.ai/zen/v1",
		model: "kimi-k2.6",
		local: false,
		needsApiKey: true,
		apiKeyEnv: "OPENCODE_API_KEY",
	},
	custom: {
		label: "Otro servidor compatible con OpenAI",
		dialect: "openai",
		baseUrl: "http://localhost:8000/v1",
		model: "default",
		local: true,
		needsApiKey: false,
	},
};

export type LLMSettings = {
	provider: LLMProvider;
	dialect: "openai" | "ollama";
	baseUrl: string;
	model: string;
	apiKey: string;
	local: boolean;
	headers: Record<string, string>;
	contextWindow: number;
	timeoutMs: number;
	temperature?: number;
	toolMode: "auto" | "native" | "text";
};

function normalizeBaseUrl(url: string, dialect: "openai" | "ollama"): string {
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
export function resolveLLMSettings(): LLMSettings {
	const cfg = getConfig();
	const env = process.env;
	const envProvider = env.SHIRO_LLM_PROVIDER?.trim() as LLMProvider | undefined;
	const provider: LLMProvider = envProvider && envProvider in PROVIDER_PRESETS ? envProvider : cfg.llmProvider;
	const preset = PROVIDER_PRESETS[provider];

	const baseUrl = normalizeBaseUrl(env.SHIRO_LLM_BASE_URL?.trim() || cfg.llmBaseUrl || preset.baseUrl, preset.dialect);
	const model = env.SHIRO_LLM_MODEL?.trim() || cfg.llmModel || preset.model;
	const apiKey =
		env.SHIRO_LLM_API_KEY?.trim() ||
		cfg.llmApiKey ||
		(preset.apiKeyEnv ? env[preset.apiKeyEnv]?.trim() : "") ||
		"";

	const headers: Record<string, string> = { "Content-Type": "application/json", ...preset.extraHeaders };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	return {
		provider,
		dialect: preset.dialect,
		baseUrl,
		model,
		apiKey,
		local: preset.local,
		headers,
		contextWindow: cfg.contextWindow,
		timeoutMs: cfg.llmTimeoutMs,
		temperature: cfg.temperature,
		toolMode: cfg.toolMode,
	};
}

/** API key enmascarada para mostrar en pantalla o logs. */
export function maskKey(key: string): string {
	return key ? `***${key.slice(-4)}` : "";
}
