import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");

export type AppConfig = {
	model?: string;
	vllmBaseUrl?: string;
	vllmApiKey?: string;
	llmProvider?: "vllm" | "ollama" | "openrouter" | "opencode";
	ollamaModel?: string;
	ollamaBaseUrl?: string;
	openrouterApiKey?: string;
	openrouterModel?: string;
	openrouterBaseUrl?: string;
	opencodeApiKey?: string;
	opencodeModel?: string;
	opencodeBaseUrl?: string;
	abilities?: string;
	/**
	 * Si true (default), guarda el historial de chats en disco.
	 * Si false, las conversaciones solo existen en memoria durante la sesión.
	 */
	persistChatHistory?: boolean;
	/** Si true (default), usa herramientas; si false, solo chat en texto. */
	autonomousMode?: boolean;
	/**
	 * Explicación de uso de herramientas:
	 * - off: nunca menciona herramientas
	 * - brief: una línea corta si usó herramientas (default)
	 * - on: lista corta de herramientas usadas
	 */
	explainMode?: "off" | "brief" | "on";
	/** Número máximo de rondas de tool-calls por respuesta. */
	maxToolIterations?: number;
	/** Límite de caracteres por resultado de herramienta enviado al modelo. */
	maxToolResultChars?: number;
	/** Rutas (absolutas o relativas al CWD) con skills */ 
	skillPaths?: string[];
	/** Máximo de caracteres totales de skills inyectados. */
	skillsMaxChars?: number;
	/** Rol del agente: default, dev, analyst, hacker */
	role?: "default" | "dev" | "analyst" | "hacker";
};

const DEFAULTS: AppConfig = {
	model: "default",
	vllmBaseUrl: "http://127.0.0.1:8000/v1",
	vllmApiKey: undefined,
	llmProvider: "vllm",
	ollamaModel: "llama3.2",
	ollamaBaseUrl: "http://localhost:11434",
	openrouterApiKey: undefined,
	openrouterModel: "openai/gpt-4o-mini",
	openrouterBaseUrl: "https://openrouter.ai/api/v1",
	opencodeApiKey: undefined,
	opencodeModel: "kimi-k2.6",
	opencodeBaseUrl: "https://api.opencode.ai/v1",
	abilities: undefined,
	persistChatHistory: true,
	autonomousMode: true,
	explainMode: "off",
	maxToolIterations: 10,
	maxToolResultChars: 12000,
	skillPaths: [],
	skillsMaxChars: 3000,
	role: "default",
};

function isValidUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function isValidModel(model: string | undefined): boolean {
	if (!model || typeof model !== "string") return false;
	const trimmed = model.trim();
	return trimmed.length > 0 && trimmed.length <= 100;
}

function sanitizeUrl(url: string | undefined, fallback: string): string {
	if (!url || typeof url !== "string") return fallback;
	const cleaned = url.replace(/\/+$/, "").trim();
	if (!cleaned) return fallback;
	return isValidUrl(cleaned) ? cleaned : fallback;
}

function sanitizeModel(model: string | undefined): string {
	if (!model || typeof model !== "string") return DEFAULTS.model!;
	const trimmed = model.trim();
	return isValidModel(trimmed) ? trimmed : DEFAULTS.model!;
}

function sanitizeExplainMode(v: unknown): "off" | "brief" | "on" {
	return v === "off" || v === "brief" || v === "on" ? v : (DEFAULTS.explainMode ?? "brief");
}

function sanitizePositiveInt(v: unknown, fallback: number, min: number, max: number): number {
	const n = typeof v === "number" ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	const value = Math.trunc(n);
	if (value < min || value > max) return fallback;
	return value;
}

function sanitizeStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	for (const item of v) {
		if (typeof item !== "string") continue;
		const clean = item.trim();
		if (!clean || out.includes(clean)) continue;
		out.push(clean);
	}
	return out;
}

function loadConfig(): AppConfig {
	if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		const provider = data.llmProvider as string;
		return {
			model: isValidModel(data.model as string) ? (data.model as string).trim() : DEFAULTS.model,
			vllmBaseUrl: isValidUrl(data.vllmBaseUrl as string) ? (data.vllmBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.vllmBaseUrl,
			vllmApiKey: typeof data.vllmApiKey === "string" ? data.vllmApiKey : DEFAULTS.vllmApiKey,
			llmProvider: (provider === "ollama" || provider === "vllm" || provider === "openrouter" || provider === "opencode")
				? provider as "ollama" | "vllm" | "openrouter" | "opencode"
				: DEFAULTS.llmProvider,
			ollamaModel: typeof data.ollamaModel === "string" ? data.ollamaModel.trim() : DEFAULTS.ollamaModel,
			ollamaBaseUrl: isValidUrl(data.ollamaBaseUrl as string) ? (data.ollamaBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.ollamaBaseUrl,
			openrouterApiKey: typeof data.openrouterApiKey === "string" ? data.openrouterApiKey : DEFAULTS.openrouterApiKey,
			openrouterModel: typeof data.openrouterModel === "string" ? data.openrouterModel.trim() : DEFAULTS.openrouterModel,
			openrouterBaseUrl: isValidUrl(data.openrouterBaseUrl as string) ? (data.openrouterBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.openrouterBaseUrl,
			opencodeApiKey: typeof data.opencodeApiKey === "string" ? data.opencodeApiKey : DEFAULTS.opencodeApiKey,
			opencodeModel: typeof data.opencodeModel === "string" ? data.opencodeModel.trim() : DEFAULTS.opencodeModel,
			opencodeBaseUrl: isValidUrl(data.opencodeBaseUrl as string) ? (data.opencodeBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.opencodeBaseUrl,
			abilities: typeof data.abilities === "string" ? data.abilities : DEFAULTS.abilities,
			persistChatHistory: typeof data.persistChatHistory === "boolean" ? data.persistChatHistory : DEFAULTS.persistChatHistory,
			autonomousMode: typeof data.autonomousMode === "boolean" ? data.autonomousMode : DEFAULTS.autonomousMode,
			explainMode: sanitizeExplainMode(data.explainMode),
			maxToolIterations: sanitizePositiveInt(data.maxToolIterations, DEFAULTS.maxToolIterations ?? 10, 1, 40),
			maxToolResultChars: sanitizePositiveInt(data.maxToolResultChars, DEFAULTS.maxToolResultChars ?? 12000, 500, 200000),
			skillPaths: sanitizeStringArray(data.skillPaths),
			skillsMaxChars: sanitizePositiveInt(data.skillsMaxChars, DEFAULTS.skillsMaxChars ?? 3000, 500, 20000),
			role: data.role === "default" || data.role === "dev" || data.role === "analyst" || data.role === "hacker"
				? data.role
				: DEFAULTS.role,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
	if (cached === null) cached = loadConfig();
	return { ...cached };
}

export function setConfig(partial: Partial<AppConfig>): AppConfig {
	const current = getConfig();
	const next: AppConfig = {
		model: partial.model !== undefined ? sanitizeModel(partial.model) : current.model,
		vllmBaseUrl: partial.vllmBaseUrl !== undefined ? sanitizeUrl(partial.vllmBaseUrl, DEFAULTS.vllmBaseUrl!) : current.vllmBaseUrl,
		vllmApiKey: partial.vllmApiKey !== undefined ? partial.vllmApiKey : current.vllmApiKey,
		llmProvider: partial.llmProvider !== undefined ? partial.llmProvider : current.llmProvider,
		ollamaModel: partial.ollamaModel !== undefined ? partial.ollamaModel.trim() : current.ollamaModel,
		ollamaBaseUrl: partial.ollamaBaseUrl !== undefined ? sanitizeUrl(partial.ollamaBaseUrl, DEFAULTS.ollamaBaseUrl!) : current.ollamaBaseUrl,
		openrouterApiKey: partial.openrouterApiKey !== undefined ? partial.openrouterApiKey : current.openrouterApiKey,
		openrouterModel: partial.openrouterModel !== undefined ? partial.openrouterModel.trim() : current.openrouterModel,
		openrouterBaseUrl: partial.openrouterBaseUrl !== undefined ? sanitizeUrl(partial.openrouterBaseUrl, DEFAULTS.openrouterBaseUrl!) : current.openrouterBaseUrl,
		opencodeApiKey: partial.opencodeApiKey !== undefined ? partial.opencodeApiKey : current.opencodeApiKey,
		opencodeModel: partial.opencodeModel !== undefined ? partial.opencodeModel.trim() : current.opencodeModel,
		opencodeBaseUrl: partial.opencodeBaseUrl !== undefined ? sanitizeUrl(partial.opencodeBaseUrl, DEFAULTS.opencodeBaseUrl!) : current.opencodeBaseUrl,
		abilities: partial.abilities !== undefined ? partial.abilities : current.abilities,
		persistChatHistory: partial.persistChatHistory !== undefined ? partial.persistChatHistory : current.persistChatHistory,
		autonomousMode: partial.autonomousMode !== undefined ? partial.autonomousMode : current.autonomousMode,
		explainMode: partial.explainMode !== undefined ? sanitizeExplainMode(partial.explainMode) : current.explainMode,
		maxToolIterations: partial.maxToolIterations !== undefined
			? sanitizePositiveInt(partial.maxToolIterations, DEFAULTS.maxToolIterations ?? 10, 1, 40)
			: current.maxToolIterations,
		maxToolResultChars: partial.maxToolResultChars !== undefined
			? sanitizePositiveInt(partial.maxToolResultChars, DEFAULTS.maxToolResultChars ?? 12000, 500, 200000)
			: current.maxToolResultChars,
		skillPaths: partial.skillPaths !== undefined ? sanitizeStringArray(partial.skillPaths) : (current.skillPaths ?? []),
		skillsMaxChars: partial.skillsMaxChars !== undefined
			? sanitizePositiveInt(partial.skillsMaxChars, DEFAULTS.skillsMaxChars ?? 3000, 500, 20000)
			: current.skillsMaxChars,
		role: partial.role !== undefined ? partial.role : current.role,
	};
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
