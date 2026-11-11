import { getConfig } from "../../config/config.js";
import { activeModelTuning, saverOn, type ModelRef } from "./providers.js";

/** En modo ahorro: como mucho estos pasos con herramientas y este largo por resultado. */
export const SAVER_MAX_ITERATIONS = 8;
export const SAVER_MAX_RESULT_CHARS = 4000;
/** Code, Hacking y Planear son trabajos largos: el triple de «Pasos máximos», hasta este tope. */
export const WORK_STEPS_FACTOR = 3;
export const WORK_MAX_ITERATIONS = 100;
/** Un resultado no ocupa más que esta parte del contexto del modelo, ni menos que el mínimo. */
const RESULT_CONTEXT_SHARE = 6;
const MIN_RESULT_CHARS = 1500;
/** Letras por token, más o menos (como en historyBudget). */
const CHARS_PER_TOKEN = 3.5;

/**
 * Máximo de pasos con herramientas por respuesta (del modelo activo o el de `ref`, o el general).
 * `work`: Code, Hacking o Planear, donde no aplica el modo ahorro.
 */
export function getMaxToolIterations(ref?: ModelRef, saver = saverOn(ref), work = false): number {
	const max = activeModelTuning(ref).maxToolIterations;
	if (work) return Math.min(WORK_MAX_ITERATIONS, max * WORK_STEPS_FACTOR);
	return saver ? Math.min(max, SAVER_MAX_ITERATIONS) : max;
}

/**
 * Letras que puede ocupar un resultado de herramienta: lo de Ajustes (menos en modo ahorro) y, si se
 * sabe el contexto del modelo, como mucho una sexta parte de él.
 */
export function toolResultLimit(ref?: ModelRef, saver = saverOn(ref), contextTokens?: number): number {
	const configured = getConfig().maxToolResultChars ?? 12000;
	let max = saver ? Math.min(configured, SAVER_MAX_RESULT_CHARS) : configured;
	if (contextTokens && contextTokens > 0) max = Math.min(max, Math.max(MIN_RESULT_CHARS, Math.floor((contextTokens * CHARS_PER_TOKEN) / RESULT_CONTEXT_SHARE)));
	return max;
}

/**
 * Letras que pueden sumar los resultados de herramientas de una respuesta antes de recortar los viejos
 * (toolCompaction.ts): el 40 % del contexto si se sabe; si no, poco en local y más en la nube.
 */
export function toolResultsBudget(contextTokens: number | undefined, local: boolean): number {
	if (contextTokens && contextTokens > 0) return Math.floor(contextTokens * CHARS_PER_TOKEN * 0.4);
	return local ? 24_000 : 80_000;
}

/** Recorta un resultado de herramienta antes de dárselo al modelo (en modo ahorro, más corto). */
export function normalizeToolResult(content: string, ref?: ModelRef, saver = saverOn(ref), maxChars = toolResultLimit(ref, saver)): string {
	if (content.length <= maxChars) return content;
	const visible = Math.max(200, maxChars - 120);
	return `${content.slice(0, visible)}\n\n[resultado truncado: ${content.length} chars totales, mostrando ${visible}]`;
}
