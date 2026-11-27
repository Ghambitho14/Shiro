/**
 * Respaldo entre motores (Ajustes → Modelo → «Si no responde, usar…», `fallbackModels` de la config).
 *
 * Si el modelo de una respuesta no contesta (sin conexión, se acabó el tiempo, error del servidor o saturado) y
 * los reintentos no bastan, `runAgent` sigue con el siguiente modelo de la lista. Solo antes de que haya pasado
 * algo: si ya escribió texto o usó una herramienta, cambiar de modelo repetiría o mezclaría el trabajo.
 * Un motor que falló se recuerda 60 s: mientras tanto se salta directo al respaldo en vez de esperarlo otra vez.
 */
import { getConfig, type AppConfig } from "../../config/config.js";
import { isRetryableError } from "../health/RetryPolicy.js";
import { LLMError, type LLMClient } from "./LLMClient.js";
import { getLLMFor } from "./getLLM.js";
import { lacksApiKey, PROVIDER_PRESETS, type ModelRef } from "./providers.js";
import { keyHint } from "./router.js";

/** Cuánto se recuerda que un motor no respondió. */
export const FAILED_ENGINE_MS = 60_000;

/** Lo que se le dice al usuario cuando responde el respaldo. */
export type FallbackNotice = { from: string; to: string; reason: string };

const failedAt = new Map<string, number>();
let resolve: (ref: ModelRef) => LLMClient = getLLMFor;

/** El motor de un cliente: el servidor si tiene dirección (un Ollama caído falla con todos sus modelos), si no el modelo. */
export function engineKey(llm: LLMClient): string {
	const c = llm.getConfig();
	return c.baseUrl ? `${c.provider}|${c.baseUrl.replace(/\/+$/, "").toLowerCase()}` : `${c.provider}||${c.model}`;
}

/** Nombre corto del modelo para el aviso: el modelo, o el proveedor si no tiene. */
export function engineLabel(llm: LLMClient): string {
	const c = llm.getConfig();
	return c.model || PROVIDER_PRESETS[c.provider as ModelRef["provider"]]?.title || c.provider;
}

/** Si el error es de los que justifican probar otro modelo: no responde, tarda demasiado, falla su servidor o está saturado. */
export function isFallbackError(err: unknown): boolean {
	if (err instanceof LLMError) return err.retryable;
	return isRetryableError(err).retryable;
}

/** Por qué se cambió, en palabras del usuario. */
export function fallbackReason(err: unknown): string {
	if (err instanceof LLMError) {
		if (err.kind === "timeout") return "tardó demasiado";
		if (err.kind === "server") return "dio un error en su servidor";
		if (err.kind === "rate_limit") return "está saturado o se acabó tu cuota";
	}
	return "no respondió";
}

export function markEngineFailed(llm: LLMClient, now = Date.now()): void {
	failedAt.set(engineKey(llm), now);
}

export function engineRecentlyFailed(llm: LLMClient, now = Date.now()): boolean {
	const at = failedAt.get(engineKey(llm));
	if (at === undefined) return false;
	if (now - at < FAILED_ENGINE_MS) return true;
	failedAt.delete(engineKey(llm));
	return false;
}

/** Avisos para Ajustes → Modelo: los respaldos sin API key en este equipo se saltan. */
export function fallbackWarnings(cfg: AppConfig = getConfig(), env: NodeJS.ProcessEnv = process.env): string[] {
	return (cfg.fallbackModels ?? []).flatMap((ref, i) =>
		lacksApiKey(ref, cfg, env)
			? [`El ${i ? "segundo" : "primer"} respaldo (${PROVIDER_PRESETS[ref.provider].title}) no tiene API key en este equipo: se saltará. ${keyHint(ref.provider, cfg)}`]
			: [],
	);
}

/** Para las pruebas: olvida los motores caídos y, con `resolver`, crea los clientes de respaldo con modelos falsos. */
export function resetFailedEngines(resolver?: (ref: ModelRef) => LLMClient): void {
	failedAt.clear();
	resolve = resolver ?? getLLMFor;
}

/**
 * El siguiente modelo de respaldo que valga la pena probar: ni uno ya probado en esta respuesta (`tried`, con
 * `engineKey`), ni uno que falló hace menos de un minuto, ni uno sin su API key en este equipo (fallaría seguro).
 */
export function nextFallback(tried: Set<string>, cfg: AppConfig = getConfig(), now = Date.now()): LLMClient | undefined {
	for (const ref of cfg.fallbackModels ?? []) {
		if (lacksApiKey(ref, cfg)) continue;
		const llm = resolve(ref);
		if (tried.has(engineKey(llm)) || engineRecentlyFailed(llm, now)) continue;
		return llm;
	}
	return undefined;
}
