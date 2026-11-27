/**
 * Datos de cada modelo para Ajustes → Modelo: parámetros (7B), cuantización (Q4_K_M), tamaño, contexto,
 * precio y si cabe en la memoria de la tarjeta gráfica. Lo que dice el proveedor manda; si no lo dice, se
 * saca del nombre (`qwen3-8b-q4_k_m.gguf`) y el tamaño se estima (marcado como `sizeEstimated`).
 *
 * Fuentes: Ollama `/api/tags` (tamaño, `parameter_size`, `quantization_level`), LM Studio `/api/v0/models`
 * (cuantización, contexto), OpenRouter `/models` (`pricing` por token, `context_length`), el catálogo de
 * models.dev de OpenCode (`cost` por millón) y los GGUF del equipo (tamaño del archivo).
 */

/** Precio en dólares por millón de tokens (leídos / escritos). */
export type ModelPrice = { input: number; output: number };

/** Si el modelo cabe en la memoria de la tarjeta: entero con contexto, justo (poco contexto) o no (va en parte al procesador). */
export type GpuFit = "fits" | "tight" | "no";

export type ModelDetails = {
	/** Parámetros como los escribe el proveedor: "8B", "30B-A3B". */
	params?: string;
	/** Cuantización: "Q4_K_M", "Q8_0", "F16". */
	quant?: string;
	sizeBytes?: number;
	/** El tamaño salió de parámetros × cuantización, no del proveedor. */
	sizeEstimated?: boolean;
	/** Tokens de contexto que admite el modelo. */
	context?: number;
	price?: ModelPrice;
	fit?: GpuFit;
};

const GB = 1024 ** 3;

/** "8B", "1.7B", "30B-A3B" (MoE: total y activos), "270M"; null si el nombre no lo dice. */
export function paramsFromName(name: string): string | null {
	const s = name.replace(/\.gguf$/i, "");
	const moe = /(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(s);
	if (moe) return `${moe[1]}B-A${moe[2]}B`;
	const m = /(?:^|[^a-z0-9.])(?:e)?(\d+(?:\.\d+)?)([bm])(?![a-z0-9])/i.exec(s);
	return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}

const QUANT = /(?:^|[^a-z0-9])(i?q\d(?:_[a-z0-9]+)*|f16|bf16|fp16|f32|mxfp4)(?![a-z0-9])/i;

/** "Q4_K_M", "IQ4_XS", "Q8_0", "F16"…; null si el nombre no lo dice. */
export function quantFromName(name: string): string | null {
	const m = QUANT.exec(name.replace(/\.gguf$/i, ""));
	return m ? m[1].toUpperCase() : null;
}

/** Bits por peso aproximados de cada cuantización (lo que ocupa de media en un GGUF). */
function bitsPerWeight(quant: string): number | null {
	const q = quant.toUpperCase();
	if (/^(F32)$/.test(q)) return 32;
	if (/^(F16|BF16|FP16)$/.test(q)) return 16;
	if (q === "MXFP4") return 4.25;
	const m = /^I?Q(\d)/.exec(q);
	if (!m) return null;
	const n = Number(m[1]);
	// Las K y las IQ guardan algo más por bloque; las _0 casi nada. Medias de llama.cpp redondeadas.
	const table: Record<number, number> = { 1: 1.8, 2: 2.9, 3: 3.9, 4: 4.8, 5: 5.7, 6: 6.6, 8: 8.5 };
	return table[n] ?? null;
}

/** Parámetros totales en miles de millones ("30B-A3B" → 30; "270M" → 0,27). */
function paramsBillions(params: string): number | null {
	const m = /^(\d+(?:\.\d+)?)([BM])/i.exec(params);
	if (!m) return null;
	const n = Number(m[1]);
	return m[2].toUpperCase() === "M" ? n / 1000 : n;
}

/** Tamaño aproximado de los pesos: parámetros × bits por peso. */
export function estimateSizeBytes(params: string, quant: string): number | null {
	const b = paramsBillions(params);
	const bits = bitsPerWeight(quant);
	if (!b || !bits) return null;
	return Math.round((b * 1e9 * bits) / 8);
}

/**
 * ¿Cabe en la tarjeta? Además de los pesos, llama.cpp/Ollama necesitan sitio para el contexto y sus búferes
 * (~10 % más y casi 1 GB). "tight": los pesos caben pero queda poco para el contexto; "no": parte irá al
 * procesador y responderá bastante más lento.
 */
export function gpuFit(sizeBytes: number, vramBytes: number): GpuFit {
	if (sizeBytes * 1.1 + 0.9 * GB <= vramBytes) return "fits";
	if (sizeBytes <= vramBytes * 0.97) return "tight";
	return "no";
}

/** Completa lo que falte sacándolo del nombre, estima el tamaño si hace falta y calcula si cabe en la tarjeta. */
export function completeDetails(id: string, d: ModelDetails, vramBytes?: number | null): ModelDetails {
	const out: ModelDetails = { ...d };
	out.params ||= paramsFromName(id) ?? undefined;
	out.quant ||= quantFromName(id) ?? undefined;
	if (!out.sizeBytes && out.params && out.quant) {
		const est = estimateSizeBytes(out.params, out.quant);
		if (est) {
			out.sizeBytes = est;
			out.sizeEstimated = true;
		}
	}
	if (vramBytes && out.sizeBytes) out.fit = gpuFit(out.sizeBytes, vramBytes);
	for (const k of Object.keys(out) as (keyof ModelDetails)[]) if (out[k] === undefined) delete out[k];
	return out;
}

const num = (v: unknown): number | undefined => {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
	return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** Precio por token (OpenRouter manda strings como "0.0000003") → por millón. Negativo = variable: sin precio. */
export function priceFromPerToken(pricing: unknown): ModelPrice | undefined {
	const p = (pricing ?? {}) as { prompt?: unknown; completion?: unknown };
	const input = num(p.prompt);
	const output = num(p.completion);
	if (input === undefined || output === undefined) return undefined;
	return { input: round(input * 1e6), output: round(output * 1e6) };
}

/** Precio por millón (models.dev: `cost: { input, output }`). */
export function priceFromPerMillion(cost: unknown): ModelPrice | undefined {
	const c = (cost ?? {}) as { input?: unknown; output?: unknown };
	const input = num(c.input);
	const output = num(c.output);
	if (input === undefined || output === undefined) return undefined;
	return { input: round(input), output: round(output) };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Ollama `/api/tags`: un modelo con `size` y `details`. */
export function detailsFromOllama(m: unknown): ModelDetails {
	const o = (m ?? {}) as { size?: unknown; details?: { parameter_size?: unknown; quantization_level?: unknown } };
	const size = num(o.size);
	const params = typeof o.details?.parameter_size === "string" ? o.details.parameter_size.replace(/\.0(?=[BM]$)/i, "").toUpperCase() : undefined;
	const quant = typeof o.details?.quantization_level === "string" && o.details.quantization_level !== "unknown" ? o.details.quantization_level.toUpperCase() : undefined;
	return { ...(size ? { sizeBytes: size } : {}), ...(params ? { params } : {}), ...(quant ? { quant } : {}) };
}

/** Formato OpenAI `/models` (OpenRouter y otros): `context_length` y `pricing`. */
export function detailsFromOpenAI(m: unknown): ModelDetails {
	const o = (m ?? {}) as { context_length?: unknown; pricing?: unknown };
	const context = num(o.context_length);
	const price = o.pricing ? priceFromPerToken(o.pricing) : undefined;
	return { ...(context ? { context } : {}), ...(price ? { price } : {}) };
}

/** LM Studio `/api/v0/models`: `quantization` y `max_context_length`. */
export function detailsFromLmStudio(m: unknown): ModelDetails {
	const o = (m ?? {}) as { quantization?: unknown; max_context_length?: unknown };
	const context = num(o.max_context_length);
	const quant = typeof o.quantization === "string" && o.quantization.trim() ? o.quantization.trim().toUpperCase() : undefined;
	return { ...(context ? { context } : {}), ...(quant ? { quant } : {}) };
}
