/**
 * Tool Registry - Sistema centralizado de tools modulares
 * 
 * Cada tool se define con:
 * - name: nombre unico
 * - description: que hace
 * - category: grupo al que pertenece
 * - parameters: esquema
 * - examples: ejemplos de uso
 */

export interface ToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface Tool {
	name: string;
	description: string;
	category: string;
	parameters: Record<string, unknown>;
	examples?: string[];
}

export interface ToolExecutor {
	(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content?: string; error?: string }>;
}

// Registro central de todas las tools
const toolsRegistry = new Map<string, Tool>();
const executorsRegistry = new Map<string, ToolExecutor>();

export function registerTool(name: string, tool: Tool, executor: ToolExecutor): void {
	toolsRegistry.set(name, tool);
	executorsRegistry.set(name, executor);
}

export function getTool(name: string): Tool | undefined {
	return toolsRegistry.get(name);
}

export function getAllTools(): Tool[] {
	return Array.from(toolsRegistry.values());
}

export function getToolNames(): string[] {
	return Array.from(toolsRegistry.keys());
}

export function getToolsByCategory(category: string): Tool[] {
	return getAllTools().filter(t => t.category === category);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; content?: string; error?: string }> {
	const executor = executorsRegistry.get(name);
	if (!executor) {
		return { ok: false, error: `Herramienta desconocida: ${name}` };
	}
	
	try {
		return await executor(name, args);
	} catch (err) {
		return { 
			ok: false, 
			content: "",
			error: err instanceof Error ? err.message : String(err) 
		};
	}
}

export function hasExecutor(name: string): boolean {
	return executorsRegistry.has(name);
}

export function toToolDef(tool: Tool): ToolDef {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

export function getToolDefs(): ToolDef[] {
	return getAllTools().map(tool => toToolDef(tool));
}
