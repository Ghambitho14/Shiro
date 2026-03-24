import { getConfig } from "../../config/config.js";

export function getMaxToolIterations(): number {
	const cfg = getConfig();
	return cfg.maxToolIterations ?? 10;
}

export function normalizeToolResult(content: string): string {
	const cfg = getConfig();
	const maxChars = cfg.maxToolResultChars ?? 12000;
	if (content.length <= maxChars) return content;
	const visible = Math.max(200, maxChars - 120);
	return `${content.slice(0, visible)}\n\n[resultado truncado: ${content.length} chars totales, mostrando ${visible}]`;
}
