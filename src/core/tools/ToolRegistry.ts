import type { ToolResult } from "../agent/Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { executeTool } from "./tools.js";

export interface ToolDefinition {
	label: string;
	name: string;
	description: string;
	category: "archivos" | "sistema" | "web" | "utilidades" | "memoria" | "sesion";
	examples?: string[];
	parameters: ToolDef["function"]["parameters"];
}

/** Tool registry con descripciones mejoradas estilo OpenClaw */
export const TOOLS: ToolDefinition[] = [
	// ============ ARCHIVOS (Workspace) ============
	{
		label: "Leer Archivo",
		name: "read_file",
		description: "Lee el contenido de un archivo del workspace. Úsalo cuando el usuario pida leer, ver o mostrar un archivo.",
		category: "archivos",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Ruta relativa al workspace (ej: notas.txt, docs/README.md)" } },
			required: ["path"],
		},
		examples: [
			'"lee el archivo config.json" → read_file({path: "config.json"})',
			'"qué dice en README.md" → read_file({path: "README.md"})',
		],
	},
	{
		label: "Escribir Archivo",
		name: "write_file",
		description: "Crea o modifica un archivo en el workspace.",
		category: "archivos",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Ruta relativa al workspace" },
				content: { type: "string", description: "Contenido a escribir" },
			},
			required: ["path", "content"],
		},
		examples: [
			'"escribe "hola" en prueba.txt" → write_file({path: "prueba.txt", content: "hola"})',
		],
	},
	{
		label: "Listar Archivos",
		name: "list_dir",
		description: "Lista archivos y carpetas del workspace.",
		category: "archivos",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Ruta relativa (opcional)" } },
		},
		examples: [
			'"qué archivos hay" → list_dir({path: "."})',
		],
	},

	// ============ SISTEMA (PC) ============
	{
		label: "Leer Archivo del Sistema",
		name: "read_file_system",
		description: "Lee un archivo de la PC del usuario (ruta absoluta).",
		category: "sistema",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Ruta absoluta (C:/...)" } },
			required: ["path"],
		},
	},
	{
		label: "Escribir Archivo en Sistema",
		name: "write_file_system",
		description: "Escribe un archivo en la PC del usuario.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Ruta al archivo" },
				content: { type: "string", description: "Contenido" },
			},
			required: ["path", "content"],
		},
	},
	{
		label: "Listar Carpetas del Sistema",
		name: "list_dir_system",
		description: "Lista archivos y carpetas de la PC del usuario.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Ruta a la carpeta" } },
		},
	},

	// ============ WEB ============
	{
		label: "Obtener URL",
		name: "fetch_url",
		description: "Obtiene el contenido de una URL (página web, API).",
		category: "web",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "URL completa (http:// o https://)" } },
			required: ["url"],
		},
	},
	{
		label: "Buscar en Internet",
		name: "search_web",
		description: "Busca información en internet.",
		category: "web",
		parameters: {
			type: "object",
			properties: { query: { type: "string", description: "Consulta de búsqueda" } },
			required: ["query"],
		},
	},
	{
		label: "Describir Imagen",
		name: "describe_image",
		description: "Analiza y describe una imagen.",
		category: "web",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "URL de la imagen" } },
			required: ["url"],
		},
	},

	// ============ UTILIDADES ============
	{
		label: "Calculadora",
		name: "calculator",
		description: "Calcula operaciones matemáticas.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { expression: { type: "string", description: "Expresión (ej: 25 * 4, sqrt(144))" } },
			required: ["expression"],
		},
	},
	{
		label: "Obtener Hora",
		name: "get_time",
		description: "Obtiene la fecha y hora actual.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { timezone: { type: "string", description: "Zona horaria opcional" } },
		},
	},
	{
		label: "Obtener Clima",
		name: "get_weather",
		description: "Obtiene el clima actual de una ciudad.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { city: { type: "string", description: "Nombre de la ciudad" } },
			required: ["city"],
		},
	},
	{
		label: "Crear Recordatorio",
		name: "create_reminder",
		description: "Crea un recordatorio o alarma.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Título del recordatorio" },
				datetime: { type: "string", description: "Fecha/hora (ISO o relativo: 'in 30 minutes')" },
				repeat: { type: "string", description: "Repetición: daily, weekly, monthly, none" },
				description: { type: "string", description: "Descripción opcional" },
			},
			required: ["title", "datetime"],
		},
	},
	{
		label: "Listar Recordatorios",
		name: "list_reminders",
		description: "Lista los recordatorios activos.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { include_completed: { type: "boolean", description: "Incluir completados" } },
		},
	},
	{
		label: "Completar Recordatorio",
		name: "complete_reminder",
		description: "Marca un recordatorio como completado.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "ID del recordatorio" } },
			required: ["id"],
		},
	},

	// ============ MEMORIA ============
	{
		label: "Buscar en Memoria",
		name: "memory_search",
		description: "Busca en la memoria a largo plazo. Úsalo cuando el usuario pregunte sobre algo que se haya hablado antes.",
		category: "memoria",
		parameters: {
			type: "object",
			properties: { 
				query: { type: "string", description: "Qué buscar en la memoria" },
				limit: { type: "number", description: "Número de resultados (default 5)" },
			},
			required: ["query"],
		},
		examples: [
			'"qué me dijiste sobre recetas" → memory_search({query: "recetas"})',
			'"busca lo de la reunión" → memory_search({query: "reunión"})',
		],
	},
	{
		label: "Guardar en Memoria",
		name: "memory_add",
		description: "Guarda información importante en la memoria a largo plazo.",
		category: "memoria",
		parameters: {
			type: "object",
			properties: { 
				content: { type: "string", description: "Contenido a recordar" },
				type: { type: "string", description: "Tipo: conversation, tool_call, observation, decision" },
				tags: { type: "array", items: { type: "string" }, description: "Etiquetas opcionales" },
			},
			required: ["content"],
		},
	},

	// ============ SESIONES ============
	{
		label: "Listar Sesiones",
		name: "sessions_list",
		description: "Lista todas las sesiones guardadas.",
		category: "sesion",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		label: "Historial de Sesión",
		name: "sessions_history",
		description: "Obtiene el historial de mensajes de una sesión.",
		category: "sesion",
		parameters: {
			type: "object",
			properties: { 
				session_id: { type: "string", description: "ID de la sesión (opcional, usa la última si no se especifica)" },
				limit: { type: "number", description: "Número de mensajes a mostrar" },
			},
		},
	},
];

/** Conversión al formato ToolDef para el LLM */
function toToolDef(tool: ToolDefinition): ToolDef {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

const TOOL_DEFS: ToolDef[] = TOOLS.map(tool => toToolDef(tool));

/** Herramientas permitidas: HEALTH puede desactivar algunas en safe-mode. */
let enabledSet: Set<string> = new Set(TOOLS.map((t) => t.name));

export function getToolsDefinition(enabledOnly = true): ToolDef[] {
	if (!enabledOnly) return [...TOOL_DEFS];
	return TOOL_DEFS.filter((t) => enabledSet.has(t.function.name));
}

export function getAllToolNames(): string[] {
	return TOOLS.map((t) => t.name);
}

export function getToolsByCategory(category: ToolDefinition["category"]): ToolDefinition[] {
	return TOOLS.filter((t) => t.category === category);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
	return TOOLS.find((t) => t.name === name);
}

export function getToolExamples(name: string): string[] {
	const tool = getToolDefinition(name);
	return tool?.examples ?? [];
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

export async function executeToolSafe(name: string, args: Record<string, unknown>): Promise<ToolResult> {
	if (!enabledSet.has(name)) {
		return { ok: false, error: "Herramienta deshabilitada (safe-mode): " + name };
	}
	return executeTool(name, args);
}

export async function executeToolSafeScoped(
	name: string,
	args: Record<string, unknown>,
	allowedTools?: string[],
): Promise<ToolResult> {
	if (!enabledSet.has(name)) {
		return { ok: false, error: "Herramienta deshabilitada (safe-mode): " + name };
	}
	if (Array.isArray(allowedTools) && allowedTools.length > 0 && !allowedTools.includes(name)) {
		return { ok: false, error: "Herramienta no permitida en esta sesion: " + name };
	}
	return executeTool(name, args);
}
