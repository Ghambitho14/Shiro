import type { ToolResult } from "../agent/Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { executeTool } from "./tools.js";

const TOOL_DEFS: ToolDef[] = [
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Lee el contenido de un archivo del workspace. Path relativo (ej: SOUL.md, memory/2025-02-24.md).",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Ruta relativa al workspace" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description: "Escribe o sobrescribe un archivo en el workspace.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Ruta relativa al workspace" },
					content: { type: "string", description: "Contenido a escribir" },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_dir",
			description: "Lista archivos y carpetas en el workspace. Sin argumentos lista la raíz.",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Ruta relativa (opcional)" } },
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file_system",
			description: "Lee un archivo en la PC (bajo la carpeta del usuario).",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Ruta al archivo" } },
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file_system",
			description: "Escribe un archivo en la PC (bajo la carpeta del usuario).",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Ruta al archivo" },
					content: { type: "string", description: "Contenido a escribir" },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_dir_system",
			description: "Lista archivos y carpetas en la PC. Sin path lista la raíz (carpeta de usuario).",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "Ruta (opcional)" } },
			},
		},
	},
];

/** Herramientas permitidas: HEALTH puede desactivar algunas en safe-mode. */
let enabledSet: Set<string> = new Set(TOOL_DEFS.map((t) => t.function.name));

export function getToolsDefinition(enabledOnly = true): ToolDef[] {
	if (!enabledOnly) return [...TOOL_DEFS];
	return TOOL_DEFS.filter((t) => enabledSet.has(t.function.name));
}

export function getAllToolNames(): string[] {
	return TOOL_DEFS.map((t) => t.function.name);
}

export function getToolsDefinitionScoped(allowedTools?: string[]): ToolDef[] {
	if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
		return getToolsDefinition(true);
	}
	const allowed = new Set(allowedTools);
	return TOOL_DEFS.filter((t) => enabledSet.has(t.function.name) && allowed.has(t.function.name));
}

export function setToolsEnabled(names: string[], enabled: boolean): void {
	for (const name of names) {
		if (enabled) enabledSet.add(name);
		else enabledSet.delete(name);
	}
}

export function executeToolSafe(name: string, args: Record<string, unknown>): ToolResult {
	if (!enabledSet.has(name)) {
		return { ok: false, error: "Herramienta deshabilitada (safe-mode): " + name };
	}
	return executeTool(name, args);
}

export function executeToolSafeScoped(
	name: string,
	args: Record<string, unknown>,
	allowedTools?: string[],
): ToolResult {
	if (!enabledSet.has(name)) {
		return { ok: false, error: "Herramienta deshabilitada (safe-mode): " + name };
	}
	if (Array.isArray(allowedTools) && allowedTools.length > 0 && !allowedTools.includes(name)) {
		return { ok: false, error: "Herramienta no permitida en esta sesion: " + name };
	}
	return executeTool(name, args);
}
