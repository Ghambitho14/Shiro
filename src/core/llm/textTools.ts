import type { ToolDef } from "./LLMClient.js";

/**
 * Tool-calling "en texto" para modelos sin soporte nativo.
 * Usa el formato Hermes/Qwen (<tool_call>{json}</tool_call>), que muchos modelos
 * locales ya conocen por su entrenamiento.
 */

export type ParsedToolCall = { name: string; args: Record<string, unknown> };

export function buildTextToolInstructions(tools: ToolDef[]): string {
	const lines = tools.map((t) => {
		const props = t.function.parameters?.properties ?? {};
		const required = new Set(t.function.parameters?.required ?? []);
		const params = Object.entries(props)
			.map(([k, v]) => {
				const type = (v as { type?: string })?.type ?? "any";
				return `${k}${required.has(k) ? "" : "?"}: ${type}`;
			})
			.join(", ");
		return `- ${t.function.name}(${params}): ${t.function.description ?? ""}`;
	});
	return [
		"## Herramientas",
		"Puedes usar estas herramientas:",
		...lines,
		"",
		"Para usar una, responde SOLO con este bloque (sin nada más):",
		'<tool_call>{"name": "nombre_herramienta", "arguments": {"param": "valor"}}</tool_call>',
		"Recibirás el resultado en un mensaje <tool_result>. Cuando tengas la información, responde al usuario normalmente, sin <tool_call>.",
	].join("\n");
}

function toArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
		} catch {
			/* sin args válidos */
		}
	}
	return {};
}

function fromJson(text: string): ParsedToolCall | null {
	try {
		const obj = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
		if (typeof obj?.name !== "string" || !obj.name) return null;
		return { name: obj.name, args: toArgs(obj.arguments ?? obj.parameters) };
	} catch {
		return null;
	}
}

/** Extrae las llamadas a herramientas del texto del modelo. */
export function parseTextToolCalls(text: string, knownTools: Set<string>): ParsedToolCall[] {
	const calls: ParsedToolCall[] = [];
	const tagged = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
	let m: RegExpExecArray | null;
	while ((m = tagged.exec(text)) !== null) {
		const body = m[1].replace(/^```(?:json)?\s*|\s*```$/g, "");
		const call = fromJson(body);
		if (call) calls.push(call);
	}
	if (calls.length) return calls;

	// Algunos modelos olvidan las etiquetas y responden solo el JSON (a veces en ```json).
	const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		const call = fromJson(trimmed);
		if (call && knownTools.has(call.name)) return [call];
	}
	return [];
}

export function formatTextToolResult(name: string, content: string): string {
	return `<tool_result name="${name}">\n${content}\n</tool_result>`;
}

/** Texto visible para el usuario: sin bloques <tool_call>. */
export function stripToolCalls(text: string): string {
	return text.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "").trim();
}
