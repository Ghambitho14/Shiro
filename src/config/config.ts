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
	llmProvider?: "vllm" | "ollama" | "openrouter";
	ollamaModel?: string;
	ollamaBaseUrl?: string;
	openrouterApiKey?: string;
	openrouterModel?: string;
	openrouterBaseUrl?: string;
	abilities?: string;
	/** Si true (default), usa planner + herramientas; si false, solo chat en texto. */
	autonomousMode?: boolean;
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
	abilities: undefined,
	autonomousMode: true,
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

function sanitizeUrl(url: string | undefined): string {
	if (!url || typeof url !== "string") return DEFAULTS.vllmBaseUrl!;
	const cleaned = url.replace(/\/+$/, "").trim();
	if (!cleaned) return DEFAULTS.vllmBaseUrl!;
	return isValidUrl(cleaned) ? cleaned : DEFAULTS.vllmBaseUrl!;
}

function sanitizeModel(model: string | undefined): string {
	if (!model || typeof model !== "string") return DEFAULTS.model!;
	const trimmed = model.trim();
	return isValidModel(trimmed) ? trimmed : DEFAULTS.model!;
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
			llmProvider: (provider === "ollama" || provider === "vllm" || provider === "openrouter") ? provider as "ollama" | "vllm" | "openrouter" : DEFAULTS.llmProvider,
			ollamaModel: typeof data.ollamaModel === "string" ? data.ollamaModel.trim() : DEFAULTS.ollamaModel,
			ollamaBaseUrl: isValidUrl(data.ollamaBaseUrl as string) ? (data.ollamaBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.ollamaBaseUrl,
			openrouterApiKey: typeof data.openrouterApiKey === "string" ? data.openrouterApiKey : DEFAULTS.openrouterApiKey,
			openrouterModel: typeof data.openrouterModel === "string" ? data.openrouterModel.trim() : DEFAULTS.openrouterModel,
			openrouterBaseUrl: isValidUrl(data.openrouterBaseUrl as string) ? (data.openrouterBaseUrl as string).replace(/\/+$/, "") : DEFAULTS.openrouterBaseUrl,
			abilities: typeof data.abilities === "string" ? data.abilities : DEFAULTS.abilities,
			autonomousMode: typeof data.autonomousMode === "boolean" ? data.autonomousMode : DEFAULTS.autonomousMode,
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
		vllmBaseUrl: partial.vllmBaseUrl !== undefined ? sanitizeUrl(partial.vllmBaseUrl) : current.vllmBaseUrl,
		vllmApiKey: partial.vllmApiKey !== undefined ? partial.vllmApiKey : current.vllmApiKey,
		llmProvider: partial.llmProvider !== undefined ? partial.llmProvider : current.llmProvider,
		ollamaModel: partial.ollamaModel !== undefined ? partial.ollamaModel.trim() : current.ollamaModel,
		ollamaBaseUrl: partial.ollamaBaseUrl !== undefined ? sanitizeUrl(partial.ollamaBaseUrl) : current.ollamaBaseUrl,
		openrouterApiKey: partial.openrouterApiKey !== undefined ? partial.openrouterApiKey : current.openrouterApiKey,
		openrouterModel: partial.openrouterModel !== undefined ? partial.openrouterModel.trim() : current.openrouterModel,
		openrouterBaseUrl: partial.openrouterBaseUrl !== undefined ? sanitizeUrl(partial.openrouterBaseUrl) : current.openrouterBaseUrl,
		abilities: partial.abilities !== undefined ? partial.abilities : current.abilities,
		autonomousMode: partial.autonomousMode !== undefined ? partial.autonomousMode : current.autonomousMode,
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
