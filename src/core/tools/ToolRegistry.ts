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
		label: "Buscar en Internet",
		name: "search_web",
		description: "Busca información en internet. Úsalo cuando necesites información actualizada o no tengas certeza sobre algo.",
		category: "web",
		parameters: {
			type: "object",
			properties: { query: { type: "string", description: "Consulta de búsqueda" } },
			required: ["query"],
		},
		examples: [
			'"busca información sobre Python" → search_web({query: "Python programming"})',
			'"qué tiempo hace hoy" → search_web({query: "clima hoy"})',
		],
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

	// ============ SISTEMA ============
	{
		label: "Ejecutar Comando",
		name: "exec",
		description: "Ejecuta un comando en la terminal del sistema. Úsalo para: instalar paquetes, ejecutar scripts, compilar código, git operations, etc. Requiere confirmación del usuario para comandos peligrosos.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Comando a ejecutar (sin comillas extras)" },
				timeout: { type: "number", description: "Timeout en ms (default 30000)" },
				workingDir: { type: "string", description: "Directorio de trabajo opcional" },
			},
			required: ["command"],
		},
		examples: [
			'"ejecuta npm install" → exec({command: "npm install"})',
			'"compila el proyecto" → exec({command: "pnpm build"})',
			'"git status" → exec({command: "git status"})',
		],
	},
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

	// ============ TAREA PROGRAMADA ============
	{
		label: "Crear Tarea Programada",
		name: "cron_create",
		description: "Crea una tarea que se ejecuta periódicamente. Úsalo para recordatorios recurrentes, tareas de mantenimiento, o acciones programadas.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Nombre de la tarea" },
				expression: { type: "string", description: "Frecuencia: '30 minutos', '2 horas', '1 día'" },
				action: { type: "string", description: "Tipo: notify, exec, reminder" },
				message: { type: "string", description: "Mensaje para notify/reminder" },
				command: { type: "string", description: "Comando a ejecutar (para action=exec)" },
			},
			required: ["name", "expression", "action"],
		},
		examples: [
			'"recordatorio cada hora" → cron_create({name: "Recordatorio", expression: "1 hora", action: "reminder", message: "Toma agua"})',
			'"ejecutar script cada día" → cron_create({name: "Backup", expression: "1 día", action: "exec", command: "npm run backup"})',
		],
	},
	{
		label: "Listar Tareas Programadas",
		name: "cron_list",
		description: "Lista todas las tareas programadas activas.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		label: "Eliminar Tarea Programada",
		name: "cron_delete",
		description: "Elimina una tarea programada por su ID.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "ID de la tarea" } },
			required: ["id"],
		},
	},
	{
		label: "Activar/Desactivar Tarea",
		name: "cron_toggle",
		description: "Activa o desactiva una tarea programada sin eliminarla.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { 
				id: { type: "string", description: "ID de la tarea" },
				enabled: { type: "boolean", description: "true para activar, false para desactivar" },
			},
			required: ["id", "enabled"],
		},
	},

	// ============ AUTO-MODIFICACIÓN ============
	{
		label: "Analizar Proyecto",
		name: "project_analyze",
		description: "Analiza la estructura de un proyecto de código. Úsalo para entender cómo funciona un proyecto, qué tecnologías usa, y su estructura de archivos.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Ruta al proyecto (default: workspace)" },
				deep: { type: "boolean", description: "Análisis profundo (default: false)" },
			},
		},
		examples: [
			'"analiza este proyecto" → project_analyze({path: "."})',
			'"qué hace este código" → project_analyze({path: "./src", deep: true})',
		],
	},
	{
		label: "Auto-Modificar Código",
		name: "self_modify",
		description: "Modifica el propio código de Shiro (archivos en src/). Úsalo para corregir bugs, refactorizar, añadir features, o mejorar el código. El archivo debe existir y estar en src/.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				file: { type: "string", description: "Archivo a modificar (ej: src/core/agent/Agent.ts)" },
				search: { type: "string", description: "Texto a buscar en el archivo" },
				replace: { type: "string", description: "Texto de reemplazo (deja vacío para solo buscar)" },
			},
			required: ["file", "search"],
		},
		examples: [
			'"corrige el bug en Agent.ts" → self_modify({file: "src/core/agent/Agent.ts", search: "bug...", replace: "codigo corregido"})',
			'"refactoriza la función" → self_modify({file: "src/core/tools/tools.ts", search: "function old", replace: "function new..."})',
		],
	},
	{
		label: "Git Operations",
		name: "git",
		description: "Ejecuta operaciones de git. Úsalo para commit, status, push, pull, branch, log, diff.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Comando git (sin 'git', ej: 'status', 'add .', 'commit -m \"msg\"')" },
				repoPath: { type: "string", description: "Ruta al repo (default: workspace)" },
			},
			required: ["command"],
		},
		examples: [
			'"qué cambios hay" → git({command: "status"})',
			'"guarda los cambios" → git({command: "add . && commit -m \"mejora\""})',
		],
	},

	// ============ AUTO-REFLEXIÓN ============
	{
		label: "Auto-Analizarse",
		name: "self_analyze",
		description: "Analiza el propio código de Shiro para entender su estado actual y sugiere mejoras. Úsalo para auto-diagnosticarte.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		label: "Reflexiones",
		name: "self_reflect",
		description: "Lista las reflexiones previas del sistema, insights generados, y sugerencias de mejora pendientes.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				pending: { type: "boolean", description: "Solo mostrar pendientes (default: false)" },
			},
		},
	},
	{
		label: "Preguntar al Usuario",
		name: "ask_user",
		description: "Haz una pregunta al usuario para entender mejor qué necesita. Úsalo cuando no tengas claro el propósito de su solicitud. Retorna la respuesta del usuario.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", description: "La pregunta para el usuario" },
			},
			required: ["question"],
		},
		examples: [
			'"no entiendo qué necesitas" → ask_user({question: "¿Para qué necesitas este archivo?"})',
			'"necesito más contexto" → ask_user({question: "¿Qué esperas que haga este código?"})',
		],
	},

	// ============ CANALES ============
	{
		label: "Crear Canal",
		name: "channel_create",
		description: "Crea un nuevo canal de comunicación (Telegram, Discord, etc). USA ESTO cuando el usuario quiera conectarse desde otra plataforma.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Nombre del canal (ej: 'Mi Telegram')" },
				type: { type: "string", description: "Tipo: telegram, discord, slack" },
				token: { type: "string", description: "Token del bot/API" },
			},
			required: ["name", "type", "token"],
		},
		examples: [
			'"créame un canal de Telegram" → channel_create({name: "Telegram", type: "telegram", token: "mi-token"})',
		],
	},
	{
		label: "Listar Canales",
		name: "channel_list",
		description: "Lista todos los canales configurados.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {},
		},
	},
	{
		label: "Iniciar Canal",
		name: "channel_start",
		description: "Inicia un canal existente. El canal debe estar creado primero.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "ID del canal" } },
			required: ["id"],
		},
	},
	{
		label: "Eliminar Canal",
		name: "channel_delete",
		description: "Elimina un canal configurado.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "ID del canal" } },
			required: ["id"],
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
