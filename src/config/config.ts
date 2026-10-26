import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolveDataDir } from "../runtime.js";

/** Carpeta de datos: data/ del proyecto, o SHIRO_DATA_DIR (pruebas), o la del .exe (ver runtime.ts). */
const DATA_DIR = resolveDataDir();
const CONFIG_FILE = join(DATA_DIR, "config.json");

export const LLM_PROVIDERS = ["ollama", "lmstudio", "llamacpp", "gguf", "vllm", "openrouter", "opencode", "opencode-go", "custom"] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];
export const STORAGE_KINDS = ["local", "obsidian", "supabase"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];

/**
 * Cada campo tiene su valor por defecto y `.catch()`: si el valor guardado es inválido
 * se usa el default en vez de romper toda la configuración.
 */
const urlSchema = z
	.string()
	.trim()
	.transform((u) => u.replace(/\/+$/, ""))
	.refine((u) => {
		try {
			const p = new URL(u).protocol;
			return p === "http:" || p === "https:";
		} catch {
			return false;
		}
	});

const optionalString = z.string().trim().min(1).optional().catch(undefined);
const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def).catch(def);

const THINKING = ["auto", "on", "off"] as const;
const KV_CACHE = ["f16", "q8_0", "q4_0"] as const;
const FLASH_ATTENTION = ["auto", "on", "off"] as const;
const TOOL_MODES = ["auto", "native", "text"] as const;
const TOOL_PROFILES = ["auto", "lite", "full"] as const;
const opt = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

/**
 * Ajustes propios de un modelo (Ajustes → Modelo → "Solo este modelo"). Lo que no está aquí sale
 * de los generales (los campos sueltos de la configuración). Ver src/core/llm/modelSettings.ts.
 */
export const modelTuningSchema = z.object({
	temperature: opt(z.number().min(0).max(2)),
	/** Pensar antes de responder (Qwen3 y otros): auto = lo que diga el modelo. */
	thinking: opt(z.enum(THINKING)),
	/** Largo máximo de la respuesta (tokens). */
	maxTokens: opt(z.number().int().min(64).max(131_072)),
	/** llama.cpp integrado: 0 = automático. Ollama: num_ctx. */
	contextSize: opt(z.number().int().min(0).max(1_000_000)),
	/** llama.cpp integrado: capas en la tarjeta gráfica. */
	gpuLayers: opt(z.union([z.enum(["auto", "all"]), z.number().int().min(0).max(999)])),
	/** llama.cpp integrado: memoria del contexto (q8_0 = la mitad de memoria, casi igual de buena). */
	kvCache: opt(z.enum(KV_CACHE)),
	/** llama.cpp integrado: hilos del procesador (0 = automático). */
	threads: opt(z.number().int().min(0).max(256)),
	flashAttention: opt(z.enum(FLASH_ATTENTION)),
	toolMode: opt(z.enum(TOOL_MODES)),
	toolProfile: opt(z.enum(TOOL_PROFILES)),
	maxToolIterations: opt(z.number().int().min(1).max(40)),
	timeoutMs: opt(z.number().int().min(5_000).max(1_800_000)),
});

export type ModelTuning = z.infer<typeof modelTuningSchema>;

const configSchema = z.object({
	/**
	 * Proveedor del modelo. Los locales (ollama, lmstudio, llamacpp, gguf) no necesitan API key.
	 * gguf: Shiro abre su propio llama.cpp con un archivo GGUF del equipo (ver src/core/llamacpp/).
	 */
	llmProvider: z.enum(LLM_PROVIDERS).default("ollama").catch("ollama"),
	/** URL del servidor. Vacío = la del preset del proveedor. */
	llmBaseUrl: urlSchema.optional().catch(undefined),
	/** Nombre del modelo. Vacío = el del preset del proveedor. */
	llmModel: optionalString,
	llmApiKey: optionalString,
	/** Tamaño de contexto (tokens) que se pide al servidor local (Ollama: num_ctx; llama.cpp integrado: -c). */
	contextWindow: int(8192, 1024, 1_000_000),
	/** Tiempo máximo por petición al modelo (ms). */
	llmTimeoutMs: int(180_000, 5_000, 1_800_000),
	temperature: z.coerce.number().min(0).max(2).optional().catch(undefined),
	/**
	 * Cómo se llaman las herramientas:
	 * - auto: nativo; si el modelo no soporta tools, cambia a texto automáticamente
	 * - native: solo tool-calling nativo
	 * - text: el modelo escribe <tool_call>{...}</tool_call> (para modelos sin soporte nativo)
	 */
	toolMode: z.enum(TOOL_MODES).default("auto").catch("auto"),
	/**
	 * Cuántas herramientas se ofrecen al modelo:
	 * - auto: "lite" para proveedores locales, "full" para la nube
	 * - lite: solo las esenciales (mejor para modelos pequeños)
	 * - full: todas las del rol
	 */
	toolProfile: z.enum(TOOL_PROFILES).default("auto").catch("auto"),
	/** llama.cpp integrado: carpetas extra donde buscar archivos .gguf (además de LM Studio, Ollama y data/models). */
	ggufFolders: z.array(z.string().trim().min(1)).default([]).catch([]),
	/** llama.cpp integrado: qué versión descargar. auto = CUDA si hay NVIDIA, si no Vulkan (Windows) o CPU. */
	llamaBackend: z.enum(["auto", "cuda", "vulkan", "cpu"]).default("auto").catch("auto"),
	/** llama.cpp integrado: minutos sin uso tras los que se libera la memoria de la GPU (0 = nunca). */
	llamaIdleMinutes: int(10, 0, 1440),
	/**
	 * llama.cpp integrado: tamaño de contexto (tokens). 0 = automático: el mayor que quepa en la
	 * tarjeta gráfica (hasta el máximo del modelo). Las instrucciones y herramientas de Shiro ya
	 * ocupan varios miles, así que 8192 se queda corto en cuanto se leen archivos.
	 */
	llamaContext: int(0, 0, 1_000_000),
	/** llama.cpp integrado (generales): capas en GPU, memoria del contexto, hilos y flash attention. */
	llamaGpuLayers: z.union([z.enum(["auto", "all"]), z.number().int().min(0).max(999)]).default("auto").catch("auto"),
	llamaKvCache: z.enum(KV_CACHE).default("f16").catch("f16"),
	llamaThreads: int(0, 0, 256),
	llamaFlashAttention: z.enum(FLASH_ATTENTION).default("auto").catch("auto"),
	/** Pensar antes de responder (modelos locales que lo permiten). auto = lo que diga el modelo. */
	thinking: z.enum(THINKING).default("auto").catch("auto"),
	/** Largo máximo de la respuesta en tokens (vacío = sin límite). */
	maxTokens: z.coerce.number().int().min(64).max(131_072).optional().catch(undefined),
	/** Ajustes propios de cada modelo, por "<proveedor>|<modelo>" (ver modelSettings.ts). */
	modelSettings: z.record(z.string().min(1).max(400), modelTuningSchema.catch({})).default({}).catch({}),
	/** Modelo de embeddings (Ollama) para la memoria vectorial. */
	embeddingsModel: z.string().trim().min(1).default("nomic-embed-text").catch("nomic-embed-text"),
	embeddingsBaseUrl: urlSchema.optional().catch(undefined),

	abilities: z.string().optional().catch(undefined),
	/** Instrucciones base del system prompt escritas por el usuario (vacío = las de core/soul/soul.ts). */
	systemPrompt: z.string().max(20000).optional().catch(undefined),
	/** Si true, guarda el historial de chats en disco. */
	persistChatHistory: z.boolean().default(true).catch(true),
	/** Si true, usa herramientas; si false, solo chat en texto. */
	autonomousMode: z.boolean().default(true).catch(true),
	/** off: nunca menciona herramientas · brief: una línea · on: lista de herramientas usadas */
	explainMode: z.enum(["off", "brief", "on"]).default("off").catch("off"),
	/** Número máximo de rondas de tool-calls por respuesta. */
	maxToolIterations: int(10, 1, 40),
	/** Límite de caracteres por resultado de herramienta enviado al modelo. */
	maxToolResultChars: int(12000, 500, 200000),
	/** Carpetas extra con habilidades (absolutas o relativas al CWD). */
	skillPaths: z.array(z.string().trim().min(1)).default([]).catch([]),
	/**
	 * Aplicaciones cuyas habilidades NO se usan (ids de EXTERNAL_SKILL_SOURCES: "claude", "codex"…).
	 * Las que no están aquí se detectan y se usan solas.
	 */
	disabledSkillSources: z.array(z.string().trim().min(1)).default([]).catch([]),
	/** Habilidades apagadas una a una ("<origen>:<nombre>", p. ej. "claude:find-skills"). */
	disabledSkills: z.array(z.string().trim().min(1)).default([]).catch([]),
	/** Habilidades incluidas con otra app (empiezan apagadas) que el usuario encendió. */
	enabledSkills: z.array(z.string().trim().min(1)).default([]).catch([]),
	/** Máximo de caracteres de la lista de habilidades en el system prompt. */
	skillsMaxChars: int(3000, 500, 20000),

	/**
	 * Aprobación de acciones peligrosas (exec, escribir archivos, git, cron exec):
	 * - ask: pregunta al usuario (en canales sin forma de preguntar, se bloquean)
	 * - allow: se ejecutan sin preguntar (no recomendado)
	 * - deny: nunca se ejecutan
	 */
	approvalMode: z.enum(["ask", "allow", "deny"]).default("ask").catch("ask"),
	/** Comandos que `exec` puede correr sin preguntar (primera palabra, ej. "git", "npm"). */
	execAllowlist: z.array(z.string().trim().min(1)).default([]).catch([]),

	/** Herramientas para controlar el PC (abrir apps, volumen, ventanas, teclado, ratón…). */
	pcControl: z.boolean().default(true).catch(true),
	/**
	 * Si el modelo puede ver imágenes (capturas de pantalla, fotos adjuntas):
	 * - auto: se deduce del nombre del modelo (llava, qwen2.5-vl, gemma3, gpt-4o, claude…)
	 * - on / off: forzado
	 */
	vision: z.enum(["auto", "on", "off"]).default("auto").catch("auto"),

	/**
	 * Voz. "browser" usa el reconocimiento y la voz del navegador (sin instalar nada).
	 * "server" usa un servidor compatible con OpenAI: Whisper (/audio/transcriptions)
	 * y TTS (/audio/speech). Sirven OpenAI, Groq, speaches, Kokoro-FastAPI, LocalAI…
	 */
	sttEngine: z.enum(["browser", "server"]).default("browser").catch("browser"),
	sttBaseUrl: urlSchema.optional().catch(undefined),
	sttModel: z.string().trim().min(1).default("whisper-1").catch("whisper-1"),
	sttApiKey: optionalString,
	ttsEngine: z.enum(["browser", "server"]).default("browser").catch("browser"),
	ttsBaseUrl: urlSchema.optional().catch(undefined),
	ttsModel: z.string().trim().min(1).default("tts-1").catch("tts-1"),
	ttsVoice: z.string().trim().min(1).default("alloy").catch("alloy"),
	ttsApiKey: optionalString,
	/**
	 * Palabra de activación (como "Alexa"): una escucha sin conexión y sin modelo que espera
	 * "<palabra>, activa <agente>" y abre el modo voz. Ver src/core/wake/.
	 */
	wakeWordEnabled: z.boolean().default(false).catch(false),
	wakeWord: z.string().trim().min(2).max(20).default("Aku").catch("Aku"),
	wakeSensitivity: z.enum(["low", "medium", "high"]).default("medium").catch("medium"),
	wakeLanguage: z.string().trim().regex(/^[a-z]{2}-[A-Z]{2}$/).default("es-MX").catch("es-MX"),

	/** La bienvenida del primer arranque ya se completó (nombre, asistente, dónde guardar, modelo). */
	setupDone: z.boolean().default(false).catch(false),
	/**
	 * Dónde se guardan los chats, recuerdos y recordatorios:
	 * - local: en data/ de este equipo
	 * - obsidian: notas en la carpeta "Shiro" de una bóveda de Obsidian (obsidianVault)
	 * - supabase: tablas shiro_* de un proyecto de Supabase (supabaseUrl + supabaseKey)
	 */
	storage: z.enum(STORAGE_KINDS).default("local").catch("local"),
	/** Ruta de la bóveda de Obsidian (carpeta que contiene .obsidian). */
	obsidianVault: optionalString,
	supabaseUrl: urlSchema.optional().catch(undefined),
	/** Clave secreta (service_role) de Supabase. Nunca se envía al navegador. */
	supabaseKey: optionalString,

	/** Telegram: token del bot (lo da @BotFather). Nunca se envía al navegador. */
	telegramToken: optionalString,
	/** Conectar Telegram al arrancar Shiro (se activa con "Conectar" en Ajustes y se quita con "Desconectar"). */
	telegramEnabled: z.boolean().default(false).catch(false),
	/** Chats de Telegram que pueden hablar con Shiro. Los demás solo reciben un aviso. */
	telegramChats: z
		.array(z.object({ id: z.string().regex(/^-?\d+$/), name: z.string().trim().max(100).catch("") }))
		.default([])
		.catch([]),
});

export type AppConfig = z.infer<typeof configSchema>;

/** Campos del formato viejo (un set de campos por proveedor). Se migran al cargar. */
type LegacyConfig = {
	model?: string;
	vllmBaseUrl?: string;
	vllmApiKey?: string;
	ollamaModel?: string;
	ollamaBaseUrl?: string;
	openrouterApiKey?: string;
	openrouterModel?: string;
	openrouterBaseUrl?: string;
	opencodeApiKey?: string;
	opencodeModel?: string;
	opencodeBaseUrl?: string;
};

function migrateLegacy(data: Record<string, unknown>): Record<string, unknown> {
	const legacy = data as LegacyConfig & Record<string, unknown>;
	const hasLegacy = ["model", "vllmBaseUrl", "ollamaModel", "openrouterModel", "opencodeModel"].some((k) => k in legacy);
	if (!hasLegacy || "llmModel" in legacy || "llmBaseUrl" in legacy) return data;

	// En el formato viejo el proveedor por defecto era vllm.
	const provider = typeof legacy.llmProvider === "string" ? legacy.llmProvider : "vllm";
	const pick: Record<string, { model?: string; baseUrl?: string; apiKey?: string }> = {
		vllm: { model: legacy.model === "default" ? undefined : legacy.model, baseUrl: legacy.vllmBaseUrl, apiKey: legacy.vllmApiKey },
		ollama: { model: legacy.ollamaModel, baseUrl: legacy.ollamaBaseUrl },
		openrouter: { model: legacy.openrouterModel, baseUrl: legacy.openrouterBaseUrl, apiKey: legacy.openrouterApiKey },
		// La URL vieja por defecto de opencode no era válida; se descarta para usar el preset.
		opencode: {
			model: legacy.opencodeModel,
			baseUrl: legacy.opencodeBaseUrl === "https://api.opencode.ai/v1" ? undefined : legacy.opencodeBaseUrl,
			apiKey: legacy.opencodeApiKey,
		},
	};
	const chosen = pick[provider] ?? {};
	const out: Record<string, unknown> = { ...data, llmProvider: provider };
	for (const key of Object.keys(legacy)) {
		if (/^(model|vllm|ollama|openrouter|opencode)/.test(key)) delete out[key];
	}
	if (chosen.model) out.llmModel = chosen.model;
	if (chosen.baseUrl) out.llmBaseUrl = chosen.baseUrl;
	if (chosen.apiKey) out.llmApiKey = chosen.apiKey;
	return out;
}

export function parseConfig(data: unknown): AppConfig {
	const obj = data && typeof data === "object" ? migrateLegacy(data as Record<string, unknown>) : {};
	return configSchema.parse(obj);
}

function loadConfig(): AppConfig {
	if (!existsSync(CONFIG_FILE)) return parseConfig({});
	try {
		return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, "utf-8")));
	} catch {
		return parseConfig({});
	}
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
	if (cached === null) cached = loadConfig();
	return { ...cached };
}

export function setConfig(partial: Partial<AppConfig>): AppConfig {
	const next = parseConfig({ ...getConfig(), ...partial });
	cached = next;
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
	return next;
}

export { DATA_DIR };
