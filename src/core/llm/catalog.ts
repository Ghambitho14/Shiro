import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config/config.js";

/**
 * Catálogo de modelos de OpenCode (Zen y Go), sacado de models.dev: el mismo que usa OpenCode.
 *
 * Hace falta porque en OpenCode no todos los modelos hablan igual: unos usan
 * /chat/completions, otros /messages (formato Anthropic) y otros /responses.
 * También dice si el modelo ve imágenes y cuánto puede escribir.
 * Se guarda en data/cache y se renueva una vez al día.
 */
export type ModelApi = "chat" | "messages" | "responses" | "google";
export type CatalogId = "opencode" | "opencode-go";

export type CatalogModel = {
	name: string;
	api: ModelApi;
	vision: boolean;
	/** false = el modelo no deja fijar la temperatura. */
	temperature: boolean;
	/** Máximo de tokens que puede escribir en una respuesta. */
	output?: number;
	deprecated: boolean;
};

export type Catalog = { fetchedAt: number; providers: Partial<Record<CatalogId, Record<string, CatalogModel>>> };

const SOURCE_URL = "https://models.dev/api.json";
const CATALOG_IDS: CatalogId[] = ["opencode", "opencode-go"];
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Tras un fallo de red no se vuelve a intentar hasta pasado este tiempo. */
const RETRY_MS = 10 * 60 * 1000;
const catalogFile = () => join(DATA_DIR, "cache", "models-catalog.json");

/** models.dev indica el formato con el paquete que usa OpenCode para hablar con el modelo. */
const NPM_API: Record<string, ModelApi> = {
	"@ai-sdk/openai-compatible": "chat",
	"@ai-sdk/anthropic": "messages",
	"@ai-sdk/openai": "responses",
	"@ai-sdk/google": "google",
};

type RawModel = {
	name?: unknown;
	status?: unknown;
	temperature?: unknown;
	modalities?: { input?: unknown };
	limit?: { output?: unknown };
	provider?: { npm?: unknown };
};

/** Se queda solo con lo que Shiro necesita del JSON de models.dev (que pesa varios MB). */
export function extractCatalog(raw: unknown, now = Date.now()): Catalog {
	const catalog: Catalog = { fetchedAt: now, providers: {} };
	if (!raw || typeof raw !== "object") return catalog;
	for (const id of CATALOG_IDS) {
		const provider = (raw as Record<string, { npm?: unknown; models?: Record<string, RawModel> }>)[id];
		if (!provider?.models || typeof provider.models !== "object") continue;
		const models: Record<string, CatalogModel> = {};
		for (const [modelId, m] of Object.entries(provider.models)) {
			if (!m || typeof m !== "object") continue;
			const npm = String(m.provider?.npm ?? provider.npm ?? "");
			const inputs = Array.isArray(m.modalities?.input) ? m.modalities.input : [];
			const output = Number(m.limit?.output);
			models[modelId] = {
				name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : modelId,
				api: NPM_API[npm] ?? "chat",
				vision: inputs.includes("image"),
				temperature: m.temperature !== false,
				...(Number.isFinite(output) && output > 0 ? { output } : {}),
				deprecated: m.status === "deprecated",
			};
		}
		if (Object.keys(models).length) catalog.providers[id] = models;
	}
	return catalog;
}

/** undefined = todavía no se ha mirado el disco; null = no hay catálogo. */
let memory: Catalog | null | undefined;
let inflight: Promise<boolean> | null = null;
let lastAttempt = 0;

function load(): Catalog | null {
	if (memory !== undefined) return memory;
	memory = null;
	try {
		const data = JSON.parse(readFileSync(catalogFile(), "utf-8")) as Catalog;
		if (data && typeof data.fetchedAt === "number" && data.providers && typeof data.providers === "object") memory = data;
	} catch {
		// Sin archivo (primera vez) o corrupto: se descargará.
	}
	return memory;
}

function isEmpty(c: Catalog): boolean {
	return !Object.values(c.providers).some((p) => p && Object.keys(p).length > 0);
}

/** Modelos conocidos de un proveedor, o undefined si aún no hay catálogo. */
export function catalogModels(id: CatalogId): Record<string, CatalogModel> | undefined {
	return load()?.providers[id];
}

export function lookupModel(id: CatalogId, model: string): CatalogModel | undefined {
	return catalogModels(id)?.[model];
}

/** Id que entiende la API para lo que escribió el usuario: acepta también el nombre visible ("Kimi K3" → "kimi-k3"). */
export function resolveModelId(id: CatalogId, model: string): string {
	const models = catalogModels(id);
	if (!models || models[model]) return model;
	const wanted = model.trim().toLowerCase();
	const slug = wanted.replace(/\s+/g, "-");
	for (const [modelId, m] of Object.entries(models)) {
		if (modelId.toLowerCase() === slug || m.name.toLowerCase() === wanted) return modelId;
	}
	return model;
}

/**
 * Formato probable cuando el modelo no está en el catálogo (sin internet la primera vez,
 * o un modelo recién salido). El catálogo siempre manda sobre esto.
 */
export function guessApi(id: CatalogId, model: string): ModelApi {
	const m = model.toLowerCase();
	if (/^claude/.test(m)) return "messages";
	if (/^gemini/.test(m)) return "google";
	if (/^(gpt|grok-\d|muse|o\d)/.test(m)) return "responses";
	if (id === "opencode-go" && /^(minimax|qwen3\.\d+-flash)/.test(m)) return "messages";
	return "chat";
}

/** Descarga el catálogo si falta o tiene más de un día. Nunca lanza: devuelve si hay catálogo usable. */
export function refreshCatalog(force = false): Promise<boolean> {
	if (inflight) return inflight;
	const current = load();
	if (!force) {
		if (current && Date.now() - current.fetchedAt < MAX_AGE_MS) return Promise.resolve(true);
		if (Date.now() - lastAttempt < RETRY_MS) return Promise.resolve(Boolean(current));
	}
	lastAttempt = Date.now();
	inflight = (async () => {
		try {
			const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(12_000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = extractCatalog(await res.json());
			if (isEmpty(next)) throw new Error("catálogo vacío");
			memory = next;
			mkdirSync(join(DATA_DIR, "cache"), { recursive: true });
			writeFileSync(catalogFile(), JSON.stringify(next), "utf-8");
			return true;
		} catch {
			// Sin catálogo se sigue con el anterior o con guessApi(): no es un fallo para el usuario.
			return Boolean(memory);
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** Espera al catálogo solo si no hay ninguno; si está viejo, lo renueva sin hacer esperar. */
export async function ensureCatalog(): Promise<void> {
	const current = load();
	if (!current) {
		await refreshCatalog();
		return;
	}
	if (Date.now() - current.fetchedAt >= MAX_AGE_MS) void refreshCatalog();
}

/** Solo para pruebas: fija el catálogo en memoria (null = ninguno) sin tocar el disco ni la red. */
export function setCatalogForTests(catalog: Catalog | null): void {
	memory = catalog;
	// Evita que una prueba sin catálogo intente descargarlo.
	lastAttempt = Date.now();
}
