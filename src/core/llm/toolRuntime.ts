import { getConfig } from "../../config/config.js";
import { activeModelTuning, type ModelRef } from "./providers.js";

/** Máximo de pasos con herramientas por respuesta (del modelo activo o el de `ref`, o el general). */
export function getMaxToolIterations(ref?: ModelRef): number {
	return activeModelTuning(ref).maxToolIterations;
}

export function normalizeToolResult(content: string): string {
	const cfg = getConfig();
	const maxChars = cfg.maxToolResultChars ?? 12000;
	if (content.length <= maxChars) return content;
	const visible = Math.max(200, maxChars - 120);
	return `${content.slice(0, visible)}\n\n[resultado truncado: ${content.length} chars totales, mostrando ${visible}]`;
}
