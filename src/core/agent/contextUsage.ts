/**
 * Cuánto contexto del modelo ocupa una respuesta y en qué (el medidor de la caja de escribir).
 * El total es el que cuenta el modelo (tokens leídos en la última vuelta) cuando lo dice; el reparto
 * entre partes es aproximado (por el largo de cada una) y se ajusta para que sume ese total.
 */
import type { Message } from "./Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { approxTokens, messageTokens } from "./historyBudget.js";

export const CONTEXT_PARTS = ["messages", "instructions", "tools", "mcp", "memory", "skills", "project", "toolResults"] as const;
export type ContextPartId = (typeof CONTEXT_PARTS)[number];
export type ContextPart = { id: ContextPartId; tokens: number };

export type ContextReport = {
	/** Tokens que ocupa (lo que leyó el modelo en la última vuelta, o la estimación). */
	used: number;
	/** Tamaño del contexto del modelo, si se sabe. */
	limit?: number;
	/** true: `used` lo contó el modelo; false: es una estimación por el largo del texto. */
	exact: boolean;
	/** Calculado antes de enviar (sin respuesta del modelo). */
	preview?: boolean;
	/** Solo las partes con algo; suman `used`. */
	parts: ContextPart[];
	/** Mensajes de la conversación que se enviaron y los que tiene el chat (si no caben, se recorta). */
	sent: number;
	total: number;
};

/** Largo (en letras) de cada parte del system prompt, como las arma ContextBuilder. */
export type PromptSections = { instructions: number; memory: number; project: number; skills: number };

/** Lo que ocupan las definiciones de herramientas, separando las de Shiro de las de servidores MCP. */
export function toolTokens(defs: readonly ToolDef[]): { tools: number; mcp: number } {
	let tools = 0;
	let mcp = 0;
	for (const d of defs) {
		const chars = JSON.stringify(d).length;
		if (d.function.name.startsWith("mcp__")) mcp += chars;
		else tools += chars;
	}
	return { tools: tools ? approxTokens(tools) : 0, mcp: mcp ? approxTokens(mcp) : 0 };
}

/**
 * Reparte `total` entre las partes en proporción a su estimación, con enteros que suman justo `total`
 * (el resto del redondeo va a las que más perdieron). Las partes en 0 se quedan en 0.
 */
export function scaleParts(parts: ContextPart[], total: number): ContextPart[] {
	const sum = parts.reduce((n, p) => n + p.tokens, 0);
	if (sum <= 0 || total <= 0) return parts.map((p) => ({ ...p, tokens: 0 }));
	const raw = parts.map((p) => (p.tokens * total) / sum);
	const out = raw.map((v, i) => ({ id: parts[i].id, tokens: Math.floor(v) }));
	let left = total - out.reduce((n, p) => n + p.tokens, 0);
	const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
	for (const { i } of order) {
		if (left <= 0) break;
		if (parts[i].tokens <= 0) continue;
		out[i].tokens++;
		left--;
	}
	return out;
}

export function measureContext(input: {
	sections: PromptSections;
	/** La conversación que se envió (ya recortada). */
	history: readonly Message[];
	/** Mensajes que tiene el chat entero. */
	totalMessages: number;
	tools: readonly ToolDef[];
	/** Letras de los resultados de herramientas de esta respuesta (como se le dieron al modelo). */
	toolResultChars?: number;
	/** Tokens que leyó el modelo en la última vuelta, si lo dijo. */
	realInput?: number;
	limit?: number;
	preview?: boolean;
}): ContextReport {
	const s = input.sections;
	const t = toolTokens(input.tools);
	const estimate: Record<ContextPartId, number> = {
		messages: input.history.reduce((n, m) => n + messageTokens(m), 0),
		instructions: s.instructions ? approxTokens(s.instructions) : 0,
		tools: t.tools,
		mcp: t.mcp,
		memory: s.memory ? approxTokens(s.memory) : 0,
		skills: s.skills ? approxTokens(s.skills) : 0,
		project: s.project ? approxTokens(s.project) : 0,
		toolResults: input.toolResultChars ? approxTokens(input.toolResultChars) : 0,
	};
	let parts: ContextPart[] = CONTEXT_PARTS.map((id) => ({ id, tokens: estimate[id] }));
	const estimated = parts.reduce((n, p) => n + p.tokens, 0);
	const exact = typeof input.realInput === "number" && input.realInput > 0;
	const used = exact ? Math.round(input.realInput!) : estimated;
	if (exact) parts = scaleParts(parts, used);
	return {
		used,
		...(input.limit && input.limit > 0 ? { limit: Math.round(input.limit) } : {}),
		exact,
		...(input.preview ? { preview: true } : {}),
		parts: parts.filter((p) => p.tokens > 0),
		sent: input.history.length,
		total: Math.max(input.totalMessages, input.history.length),
	};
}

/** Lo que llega del navegador al guardar un chat: solo números válidos y partes conocidas. */
export function sanitizeContextReport(raw: unknown): ContextReport | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), 1e9) : 0);
	const used = n(r.used);
	if (!used) return undefined;
	const parts = Array.isArray(r.parts)
		? r.parts
				.map((p): ContextPart | null => {
					if (!p || typeof p !== "object") return null;
					const id = (p as { id?: unknown }).id;
					const tokens = n((p as { tokens?: unknown }).tokens);
					return typeof id === "string" && (CONTEXT_PARTS as readonly string[]).includes(id) && tokens
						? { id: id as ContextPartId, tokens }
						: null;
				})
				.filter((p): p is ContextPart => p !== null)
				.slice(0, CONTEXT_PARTS.length)
		: [];
	const limit = n(r.limit);
	return {
		used,
		...(limit ? { limit } : {}),
		exact: r.exact === true,
		...(r.preview === true ? { preview: true } : {}),
		parts,
		sent: n(r.sent),
		total: n(r.total),
	};
}
