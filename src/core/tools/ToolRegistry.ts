import type { ToolResult } from "../agent/Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { executeTool } from "./tools.js";
import { noteExternalRead, requestApproval } from "./approval.js";
import { isExternalTool } from "./untrusted.js";
import { isMcpToolName, mcpManager } from "../mcp/McpManager.js";
import { shiroBrowser } from "../browser/browser.js";
import { TOOLS, type ToolDefinition } from "./toolDefinitions.js";

// Las definiciones (con sus permisos en `policy`) viven en toolDefinitions.ts y las listas se calculan en
// toolPolicy.ts; se reexportan aquí para que quien ya las importaba de este archivo no cambie.
export { TOOLS, type ToolDefinition };
export { CODE_TOOLS, HACKING_TOOLS, LITE_TOOLS, PC_TOOLS, PLAN_TOOLS, planToolsFor, WINDOWS_ONLY_TOOLS } from "./toolPolicy.js";

function short(v: unknown, max = 60): string {
	const s = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function hostOf(url: unknown): string {
	try {
		return new URL(String(url)).host;
	} catch {
		return short(url, 40);
	}
}

/** Frase corta y legible de lo que está haciendo una herramienta (para mostrar en la interfaz). */
export function describeToolUse(name: string, args: Record<string, unknown> = {}): string {
	const a = args ?? {};
	switch (name) {
		case "search_web":
			return `Buscando en internet: ${short(a.query)}`;
		case "fetch_url":
			return `Leyendo ${hostOf(a.url)}`;
		case "get_weather":
			return `Consultando el clima en ${short(a.city)}`;
		case "calculator":
			return `Calculando ${short(a.expression)}`;
		case "get_time":
			return "Mirando la hora";
		case "read_file":
		case "read_file_system":
			return `Leyendo ${short(a.path)}`;
		case "write_file":
		case "write_file_system":
			return `Escribiendo ${short(a.path)}`;
		case "list_dir":
		case "list_dir_system":
			return `Revisando la carpeta ${short(a.path) || "principal"}`;
		case "exec":
			return `Ejecutando: ${short(a.command)}`;
		case "create_reminder":
			return `Creando el recordatorio "${short(a.title)}"`;
		case "list_reminders":
			return "Revisando tus recordatorios";
		case "memory_search":
			return `Buscando en la memoria: ${short(a.query)}`;
		case "memory_add":
			return "Guardando en la memoria";
		case "use_skill":
			if (!a.name) return "Revisando las habilidades";
			return a.file ? `Leyendo ${short(a.file, 40)} de la habilidad ${short(a.name, 40)}` : `Usando la habilidad ${short(a.name, 40)}`;
		case "project": {
			const labels: Record<string, string> = {
				list: `Revisando los archivos del proyecto${a.path ? ` en ${short(a.path, 40)}` : ""}`,
				find: `Buscando archivos: ${short(a.query)}`,
				read: `Leyendo ${short(a.path)}${a.line ? ` (desde la línea ${short(a.line, 10)})` : ""}`,
				search: `Buscando en el proyecto: ${short(a.query)}`,
				edit: `Editando ${short(a.path)}`,
				write: `Escribiendo ${short(a.path)}`,
			};
			return labels[String(a.action)] ?? "Usando los archivos del proyecto";
		}
		case "todo":
			return "Actualizando la lista de tareas";
		case "ask_user": {
			const qs = Array.isArray(a.questions) ? (a.questions as { question?: unknown }[]) : [];
			return qs.length === 1 ? `Preguntándote: ${short(qs[0]?.question, 80)}` : `Haciéndote ${qs.length || "unas"} preguntas`;
		}
		case "draw":
			return `Dibujando: ${short(a.title)}`;
		case "pc_open":
			return `Abriendo ${short(a.target)}`;
		case "pc_screenshot":
			return "Mirando la pantalla";
		case "pc_keyboard": {
			const where = a.window ? ` en ${short(a.window, 30)}` : "";
			return a.text ? `Escribiendo "${short(a.text, 40)}"${where}` : `Pulsando ${short(a.keys)}${where}`;
		}
		case "pc_mouse":
			return a.action === "move" ? "Moviendo el ratón" : String(a.action ?? "").startsWith("scroll") ? "Desplazando la página" : "Haciendo clic";
		case "pc_media": {
			const labels: Record<string, string> = {
				volume_up: "Subiendo el volumen",
				volume_down: "Bajando el volumen",
				set_volume: `Poniendo el volumen al ${short(a.value)}%`,
				get_volume: "Mirando el volumen",
				mute: "Silenciando",
				unmute: "Quitando el silencio",
				play_pause: "Reproducir / pausar",
				next: "Siguiente canción",
				previous: "Canción anterior",
				stop: "Deteniendo la música",
			};
			return labels[String(a.action)] ?? "Controlando el sonido";
		}
		case "pc_windows": {
			const t = short(a.title, 40);
			const labels: Record<string, string> = {
				list: "Revisando las ventanas abiertas",
				focus: `Cambiando a ${t}`,
				minimize: `Minimizando ${t}`,
				maximize: `Maximizando ${t}`,
				restore: `Restaurando ${t}`,
				close: `Cerrando ${t}`,
				show_desktop: "Mostrando el escritorio",
			};
			return labels[String(a.action)] ?? "Gestionando ventanas";
		}
		case "pc_processes":
			return a.action === "kill" ? `Cerrando ${short(a.name)}` : "Revisando los programas abiertos";
		case "pc_clipboard":
			return a.action === "write" ? "Copiando al portapapeles" : "Leyendo el portapapeles";
		case "pc_system":
			return "Revisando el estado del PC";
		case "pc_power": {
			const labels: Record<string, string> = {
				lock: "Bloqueando el PC",
				sleep: "Suspendiendo el PC",
				shutdown: "Programando el apagado",
				restart: "Programando el reinicio",
				logoff: "Cerrando la sesión",
				cancel: "Cancelando el apagado",
			};
			return labels[String(a.action)] ?? "Energía del PC";
		}
		case "browser": {
			const labels: Record<string, string> = {
				open: `Abriendo ${hostOf(a.url) || short(a.url)} en el navegador`,
				read: "Leyendo la página",
				click: `Haciendo clic en ${shiroBrowser.describeRef(Number(a.ref)) ?? `[${short(a.ref)}]`}`,
				type: `Escribiendo "${short(a.text, 40)}"`,
				scroll: "Desplazando la página",
				back: "Volviendo a la página anterior",
				screenshot: "Mirando el navegador",
				close: "Cerrando el navegador",
			};
			return labels[String(a.action)] ?? "Usando el navegador";
		}
		case "claude_code":
			return `Claude Code está trabajando${a.continue === true ? " (sigue)" : ""}: ${short(a.task)}`;
		case "delegate": {
			const tasks = Array.isArray(a.tasks) ? (a.tasks as Record<string, unknown>[]) : [];
			const names = tasks.map((t, i) => String(t?.agent || t?.name || `Ayudante ${i + 1}`)).join(", ");
			return tasks.length === 1 ? `Encargando una tarea a ${names}` : `Repartiendo ${tasks.length} tareas: ${short(names, 80)}`;
		}
		case "terminal":
			// Lo tecleado no se muestra: podría ser una contraseña.
			return a.action === "run" ? `Ejecutando en la terminal: ${short(a.command)}` : a.action === "write" ? "Escribiendo en la terminal" : a.action === "stop" ? "Deteniendo la terminal" : "Mirando la terminal";
		default: {
			const mcp = isMcpToolName(name) ? mcpManager.lookup(name) : undefined;
			if (mcp) return `Usando ${mcp.tool} (${mcp.server})`;
			return getToolDefinition(name)?.label ?? name;
		}
	}
}

/** Algunos proveedores rechazan descripciones más largas (OpenAI, por ejemplo). */
const MAX_DESCRIPTION_CHARS = 1024;

/** La descripción con sus ejemplos, los que quepan: es lo que más ayuda a un modelo pequeño a elegir. */
function describeForModel(tool: ToolDefinition): string {
	let text = tool.description;
	let first = true;
	for (const example of tool.examples ?? []) {
		const next = `${text}${first ? "\nEjemplos:" : ""}\n- ${example}`;
		if (next.length > MAX_DESCRIPTION_CHARS) break;
		text = next;
		first = false;
	}
	return text;
}

/** Conversión al formato ToolDef para el LLM */
function toToolDef(tool: ToolDefinition): ToolDef {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: describeForModel(tool),
			parameters: tool.parameters,
		},
	};
}

const TOOL_DEFS: ToolDef[] = TOOLS.map(tool => toToolDef(tool));

export function getToolsDefinition(): ToolDef[] {
	return [...TOOL_DEFS];
}

export function getAllToolNames(): string[] {
	return TOOLS.map((t) => t.name);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
	return TOOLS.find((t) => t.name === name);
}

/** Las tools de servidores MCP solo se incluyen si vienen en la lista (resolveTools las añade). */
export function getToolsDefinitionScoped(allowedTools?: string[]): ToolDef[] {
	if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
		return getToolsDefinition();
	}
	const allowed = new Set(allowedTools);
	const builtIn = TOOL_DEFS.filter((t) => allowed.has(t.function.name));
	return allowedTools.some(isMcpToolName) ? [...builtIn, ...mcpManager.getToolDefs(allowed)] : builtIn;
}

/** Ejecuta una tool comprobando la lista permitida y la aprobación del usuario. */
export async function executeToolSafeScoped(
	name: string,
	args: Record<string, unknown>,
	allowedTools?: string[],
): Promise<ToolResult> {
	if (isMcpToolName(name)) {
		// Tools de servidores MCP: solo si se ofrecieron explícitamente en esta sesión.
		if (!Array.isArray(allowedTools) || !allowedTools.includes(name)) {
			return { ok: false, error: "Herramienta no permitida en esta sesion: " + name };
		}
		const approval = await requestApproval(name, args);
		if (!approval.ok) return { ok: false, error: approval.error };
		return markExternal(name, await mcpManager.callTool(name, args));
	}
	if (Array.isArray(allowedTools) && !allowedTools.includes(name)) {
		return { ok: false, error: "Herramienta no permitida en esta sesion: " + name };
	}
	const approval = await requestApproval(name, args);
	if (!approval.ok) return { ok: false, error: approval.error };
	return markExternal(name, await executeTool(name, args));
}

/** Tras leer una web o un servidor MCP, guardar en la memoria pide permiso (`describeRiskyAction`). */
function markExternal(name: string, r: ToolResult): ToolResult {
	if (r.ok && isExternalTool(name)) noteExternalRead();
	return r;
}
