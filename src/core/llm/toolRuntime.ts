import { getConfig } from "../../config/config.js";
import { activeModelTuning, saverOn, type ModelRef } from "./providers.js";

/** En modo ahorro: como mucho estos pasos con herramientas y este largo por resultado. */
export const SAVER_MAX_ITERATIONS = 4;
export const SAVER_MAX_RESULT_CHARS = 4000;

/** Máximo de pasos con herramientas por respuesta (del modelo activo o el de `ref`, o el general). */
export function getMaxToolIterations(ref?: ModelRef): number {
	const max = activeModelTuning(ref).maxToolIterations;
	return saverOn(ref) ? Math.min(max, SAVER_MAX_ITERATIONS) : max;
}

/** Recorta un resultado de herramienta antes de dárselo al modelo (en modo ahorro, más corto). */
export function normalizeToolResult(content: string, ref?: ModelRef, saver = saverOn(ref)): string {
	const cfg = getConfig();
	const configured = cfg.maxToolResultChars ?? 12000;
	const maxChars = saver ? Math.min(configured, SAVER_MAX_RESULT_CHARS) : configured;
	if (content.length <= maxChars) return content;
	const visible = Math.max(200, maxChars - 120);
	return `${content.slice(0, visible)}\n\n[resultado truncado: ${content.length} chars totales, mostrando ${visible}]`;
}
