import type { ToolResult } from "../agent/Types.js";
import type { ExecuteToolFn } from "../llm/LLMClient.js";

/** Parser de llamadas a herramientas desde texto */
export interface ParsedToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Intenta parsear tool calls desde texto del modelo */
export function parseToolCallsFromText(text: string): ParsedToolCall[] {
	const results: ParsedToolCall[] = [];
	
	// Patrón 1: {"name": "tool", "arguments": {...}}
	const jsonPattern = /\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]+\})/g;
	let match;
	while ((match = jsonPattern.exec(text)) !== null) {
		try {
			const args = JSON.parse(match[2]);
			results.push({ name: match[1], args });
		} catch {
			// Ignorar si no es JSON válido
		}
	}
	
	// Patrón 2: tool_name({"arg": "value"})
	const callPattern = /(\w+)\s*\(\s*(\{[^}]+\})\s*\)/g;
	while ((match = callPattern.exec(text)) !== null) {
		try {
			const args = JSON.parse(match[2]);
			results.push({ name: match[1], args });
		} catch {
			// Ignorar
		}
	}
	
	// Patrón 3: tool_name(arg="value") o tool_name(arg=value)
	const simplePattern = /(\w+)\s*\(\s*(\w+)\s*=\s*"?([^")]+)"?\s*\)/g;
	while ((match = simplePattern.exec(text)) !== null) {
		results.push({ name: match[1], args: { [match[2]]: match[3] } });
	}
	
	return results;
}

/** Ejecuta un paso parseando tools del texto */
export async function executeStepWithFallback(
	text: string,
	executeTool: ExecuteToolFn,
): Promise<{ ok: boolean; content: string; error?: string }> {
	const parsed = parseToolCallsFromText(text);
	
	if (parsed.length > 0) {
		const tool = parsed[0];
		console.log(`🔧 Ejecutando (parseado): ${tool.name}`, tool.args);
		return await executeTool(tool.name, tool.args);
	}
	
	return { ok: false, content: "", error: "No se pudo parsear tool call del texto" };
}
