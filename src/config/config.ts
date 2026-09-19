import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");

export const LLM_PROVIDERS = ["ollama", "lmstudio", "llamacpp", "vllm", "openrouter", "opencode", "custom"] as const;
export type LLMProvider = (typeof LLM_PROVIDERS)[number];

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

const configSchema = z.object({
	/** Proveedor del modelo. Los locales (ollama, lmstudio, llamacpp) no necesitan API key. */
	llmProvider: z.enum(LLM_PROVIDERS).default("ollama").catch("ollama"),
	/** URL del servidor. Vacío = la del preset del proveedor. */
	llmBaseUrl: urlSchema.optional().catch(undefined),
	/** Nombre del modelo. Vacío = el del preset del proveedor. */
	llmModel: optionalString,
	llmApiKey: optionalString,
	/** Tamaño de contexto (tokens) que se pide al servidor local (Ollama: num_ctx). */
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
	toolMode: z.enum(["auto", "native", "text"]).default("auto").catch("auto"),
	/**
	 * Cuántas herramientas se ofrecen al modelo:
	 * - auto: "lite" para proveedores locales, "full" para la nube
	 * - lite: solo las esenciales (mejor para modelos pequeños)
	 * - full: todas las del rol
	 */
	toolProfile: z.enum(["auto", "lite", "full"]).default("auto").catch("auto"),
	/** Modelo de embeddings (Ollama) para la memoria vectorial. */
	embeddingsModel: z.string().trim().min(1).default("nomic-embed-text").catch("nomic-embed-text"),
	embeddingsBaseUrl: urlSchema.optional().catch(undefined),

	abilities: z.string().optional().catch(undefined),
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
	/** Rutas (absolutas o relativas al CWD) con skills. */
	skillPaths: z.array(z.string().trim().min(1)).default([]).catch([]),
	/** Máximo de caracteres totales de skills inyectados. */
	skillsMaxChars: int(3000, 500, 20000),
	/** Rol del agente. */
	role: z.enum(["default", "dev", "analyst", "hacker"]).default("default").catch("default"),

	/**
	 * Aprobación de acciones peligrosas (exec, escribir archivos, git, self_modify, cron exec):
	 * - ask: pregunta al usuario (en canales sin forma de preguntar, se bloquean)
	 * - allow: se ejecutan sin preguntar (no recomendado)
	 * - deny: nunca se ejecutan
	 */
	approvalMode: z.enum(["ask", "allow", "deny"]).default("ask").catch("ask"),
	/** Comandos que `exec` puede correr sin preguntar (primera palabra, ej. "git", "npm"). */
	execAllowlist: z.array(z.string().trim().min(1)).default([]).catch([]),
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

export async function resetConfig(alsoState: boolean): Promise<void> {
	cached = null;
	if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
	if (alsoState) {
		const { resetState } = await import("../store.js");
		resetState();
	}
}

export { DATA_DIR };
