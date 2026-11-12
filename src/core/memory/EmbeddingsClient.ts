/**
 * Embeddings (el «significado» de un texto como lista de números): los usan la búsqueda de recuerdos
 * y la búsqueda por significado en proyectos (`semanticIndex.ts`).
 *
 * De dónde salen, en este orden:
 * 1. `embeddingsBaseUrl` de la config: con «/v1» al final se habla OpenAI (`/embeddings`), si no, Ollama.
 * 2. Si el chat usa un servidor local con formato OpenAI (LM Studio, llama.cpp, vLLM…), ese mismo servidor,
 *    con el modelo de su lista que coincida con `embeddingsModel` (o el primero que tenga «embed» en el nombre).
 * 3. Ollama: la dirección del chat si usa Ollama, si no `localhost:11434`.
 * La clave del chat solo se manda a la dirección del chat.
 */
import { getConfig } from "../../config/config.js";
import { resolveLLMSettings } from "../llm/providers.js";

export interface EmbeddingsProvider {
	embed(text: string): Promise<number[]>;
	/** Varios textos de una vez (más rápido para indexar). */
	embedMany(texts: string[]): Promise<number[][]>;
	getModel(): string;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Ollama nativo (`/api/embed`, con `/api/embeddings` de respaldo para versiones viejas). */
export class OllamaEmbeddings implements EmbeddingsProvider {
	private baseUrl: string;
	private model: string;

	constructor(opts: { baseUrl?: string; model?: string } = {}) {
		const config = getConfig();
		const llm = resolveLLMSettings();
		// Si el chat ya usa Ollama, se reutiliza su URL para los embeddings.
		const ollamaUrl = llm.dialect === "ollama" ? llm.baseUrl : "http://localhost:11434";
		this.baseUrl = (opts.baseUrl ?? config.embeddingsBaseUrl ?? ollamaUrl).replace(/\/+$/, "");
		this.model = opts.model ?? config.embeddingsModel;
	}

	async embed(text: string): Promise<number[]> {
		return (await this.embedMany([text]))[0];
	}

	async embedMany(texts: string[]): Promise<number[][]> {
		const res = await fetch(`${this.baseUrl}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: this.model, input: texts }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (res.status === 404 && texts.length === 1) {
			// Ollama viejo: solo /api/embeddings, de a uno.
			const old = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: this.model, prompt: texts[0] }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!old.ok) throw new Error(`Ollama no dio embeddings (${old.status}): ${(await old.text()).slice(0, 200)}`);
			const data = (await old.json()) as { embedding?: number[] };
			if (!data.embedding) throw new Error("Ollama no devolvió embeddings.");
			return [data.embedding];
		}
		if (!res.ok) throw new Error(`Ollama no dio embeddings (${res.status}): ${(await res.text()).slice(0, 200)}`);
		const data = (await res.json()) as { embeddings?: number[][] };
		if (!data.embeddings || data.embeddings.length !== texts.length) throw new Error("Ollama no devolvió embeddings.");
		return data.embeddings;
	}

	getModel(): string {
		return this.model;
	}
}

/** Formato OpenAI (`POST <base>/embeddings`): LM Studio, llama.cpp, vLLM, servidores compatibles. */
export class OpenAIEmbeddings implements EmbeddingsProvider {
	/** Antes de cada petición (LM Studio: cargar el modelo sin sacar al de chat). */
	beforeRequest?: () => Promise<void>;

	constructor(
		private baseUrl: string,
		private model: string,
		private apiKey = "",
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
	}

	async embed(text: string): Promise<number[]> {
		return (await this.embedMany([text]))[0];
	}

	async embedMany(texts: string[]): Promise<number[][]> {
		await this.beforeRequest?.();
		const res = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
			body: JSON.stringify({ model: this.model, input: texts }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`El servidor no dio embeddings (${res.status}): ${(await res.text()).slice(0, 200)}`);
		const data = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
		const rows = data.data ?? [];
		if (rows.length !== texts.length) throw new Error("El servidor no devolvió embeddings para todos los textos.");
		return [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => r.embedding);
	}

	getModel(): string {
		return this.model;
	}
}

/** Elige el modelo de embeddings de una lista: el que contenga `wanted`, o el primero con «embed». */
export function pickEmbeddingModel(ids: string[], wanted: string): string | null {
	const w = wanted.toLowerCase();
	return ids.find((id) => id.toLowerCase() === w) ?? ids.find((id) => id.toLowerCase().includes(w)) ?? ids.find((id) => /embed/i.test(id)) ?? null;
}

/** Modelo de embeddings encontrado en el servidor del chat (se recuerda 5 minutos por dirección). */
const found = new Map<string, { model: string | null; at: number }>();
const FOUND_TTL_MS = 5 * 60 * 1000;

async function findServerEmbeddingModel(baseUrl: string, apiKey: string, wanted: string): Promise<string | null> {
	const cached = found.get(baseUrl);
	if (cached && Date.now() - cached.at < FOUND_TTL_MS) return cached.model;
	let model: string | null = null;
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const data = (await res.json()) as { data?: { id: string }[] };
			model = pickEmbeddingModel((data.data ?? []).map((m) => m.id), wanted);
		}
	} catch {
		model = null;
	}
	found.set(baseUrl, { model, at: Date.now() });
	return model;
}

/** Última vez que se comprobó que el modelo de embeddings estaba cargado en LM Studio (por modelo). */
const lmLoadedAt = new Map<string, number>();
const LM_CHECK_MS = 30_000;

/**
 * LM Studio, al cargar un modelo «al vuelo» (JIT), saca al que estaba cargado: el de chat. Cargado con
 * su API (`/api/v1/models/load`) conviven. Se comprueba como mucho cada 30 s; si la API no existe
 * (LM Studio viejo), se sigue igual.
 */
async function ensureLmStudioLoaded(baseUrl: string, model: string, apiKey: string): Promise<void> {
	const key = `${baseUrl}|${model}`;
	if (Date.now() - (lmLoadedAt.get(key) ?? 0) < LM_CHECK_MS) return;
	const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
	const headers = { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
	try {
		const res = await fetch(`${root}/api/v1/models`, { headers, signal: AbortSignal.timeout(5000) });
		if (res.ok) {
			const data = (await res.json()) as { models?: { key?: string; loaded_instances?: unknown[] }[] };
			const loaded = data.models?.some((m) => m.key === model && (m.loaded_instances?.length ?? 0) > 0);
			if (!loaded) await fetch(`${root}/api/v1/models/load`, { method: "POST", headers, body: JSON.stringify({ model }), signal: AbortSignal.timeout(120_000) });
		}
	} catch {
		/* sin API de carga: LM Studio lo cargará al pedirlo */
	}
	lmLoadedAt.set(key, Date.now());
}

/** Quién da los embeddings ahora, según Ajustes (ver el comentario del principio). */
export async function resolveEmbeddingsProvider(): Promise<EmbeddingsProvider> {
	const config = getConfig();
	if (config.embeddingsBaseUrl) {
		return /\/v1\/?$/.test(config.embeddingsBaseUrl) ? new OpenAIEmbeddings(config.embeddingsBaseUrl, config.embeddingsModel) : new OllamaEmbeddings();
	}
	const llm = resolveLLMSettings();
	if (llm.dialect === "openai" && llm.local) {
		const model = await findServerEmbeddingModel(llm.baseUrl, llm.apiKey, config.embeddingsModel);
		if (model) {
			const provider = new OpenAIEmbeddings(llm.baseUrl, model, llm.apiKey);
			if (llm.provider === "lmstudio") provider.beforeRequest = () => ensureLmStudioLoaded(llm.baseUrl, model, llm.apiKey);
			return provider;
		}
	}
	return new OllamaEmbeddings();
}

/** Para quien necesita un proveedor ya: resuelve en la primera llamada. */
export function getEmbeddingsProvider(): EmbeddingsProvider {
	let ready: Promise<EmbeddingsProvider> | null = null;
	const get = () => (ready ??= resolveEmbeddingsProvider());
	return {
		embed: async (text) => (await get()).embed(text),
		embedMany: async (texts) => (await get()).embedMany(texts),
		getModel: () => getConfig().embeddingsModel,
	};
}
