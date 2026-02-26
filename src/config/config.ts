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
	abilities?: string;
};

const DEFAULTS: AppConfig = {
	model: "default",
	vllmBaseUrl: "http://127.0.0.1:8000/v1",
	vllmApiKey: undefined,
	abilities: undefined,
};

function loadConfig(): AppConfig {
	if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		const data = JSON.parse(raw) as Record<string, unknown>;
		return {
			model: typeof data.model === "string" ? data.model : DEFAULTS.model,
			vllmBaseUrl: typeof data.vllmBaseUrl === "string" ? data.vllmBaseUrl.replace(/\/+$/, "") : DEFAULTS.vllmBaseUrl,
			vllmApiKey: typeof data.vllmApiKey === "string" ? data.vllmApiKey : DEFAULTS.vllmApiKey,
			abilities: typeof data.abilities === "string" ? data.abilities : DEFAULTS.abilities,
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
		model: partial.model !== undefined ? partial.model : current.model,
		vllmBaseUrl: partial.vllmBaseUrl !== undefined ? partial.vllmBaseUrl.replace(/\/+$/, "") : current.vllmBaseUrl,
		vllmApiKey: partial.vllmApiKey !== undefined ? partial.vllmApiKey : current.vllmApiKey,
		abilities: partial.abilities !== undefined ? partial.abilities : current.abilities,
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
