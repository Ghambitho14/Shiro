import type { ToolResult } from "../agent/Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { executeTool } from "./tools.js";
import { requestApproval } from "./approval.js";
import { isMcpToolName, mcpManager } from "../mcp/McpManager.js";
import { shiroBrowser } from "../browser/browser.js";

export interface ToolDefinition {
	label: string;
	name: string;
	description: string;
	category: "archivos" | "sistema" | "web" | "utilidades" | "memoria" | "sesion" | "pc";
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
		description:
			"Búsqueda web (noticias, deportes, esports, horarios de partidos, resultados, eventos, precios, clima). Obligatorio cuando el usuario pide datos que cambian en el tiempo o no están en tu conocimiento estático; no respondas 'no sé' sin haber buscado. Incluye en la query fecha, juego/liga o ciudad cuando aplique.",
		category: "web",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Consulta específica (ej: 'Valorant VCT 2026 schedule March', 'partidos hoy liga MX')",
				},
			},
			required: ["query"],
		},
		examples: [
			'"busca información sobre Python" → search_web({query: "Python programming"})',
			'"qué tiempo hace hoy" → search_web({query: "clima hoy"})',
			'"qué partidos de valorant hay" → search_web({query: "Valorant esports matches today 2026"})',
		],
	},
	{
		label: "Obtener URL",
		name: "fetch_url",
		description:
			"Obtiene el contenido textual de una URL (HTML, JSON, XML). Úsalo cuando el usuario da un enlace oficial o quieres comprobar una fuente concreta; complementa a search_web.",
		category: "web",
		parameters: {
			type: "object",
			properties: { url: { type: "string", description: "URL completa (https://...)" } },
			required: ["url"],
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
		description: "Busca en tu memoria: los recuerdos guardados y, si el usuario guarda tus cosas en Obsidian, todas las notas de la carpeta Shiro de su bóveda. Úsalo cuando pregunte por algo que se haya hablado antes, por lo que recuerdas o por sus notas de Obsidian.",
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
			'"qué tengo en mis notas sobre la arepera" → memory_search({query: "arepera"})',
		],
	},
	{
		label: "Guardar en Memoria",
		name: "memory_add",
		description: "Guarda un dato importante (del usuario, una preferencia o una decisión) para recordarlo en otras conversaciones. Escríbelo en el idioma del usuario y como frase completa, p. ej. \"Su cámara favorita es la Fujifilm X100V\".",
		category: "memoria",
		parameters: {
			type: "object",
			properties: { 
				content: { type: "string", description: "Contenido a recordar" },
				type: { type: "string", description: "Tipo: conversation, tool_call, observation, decision" },
				tags: { type: "array", items: { type: "string" }, description: "Etiquetas opcionales" },
				important: {
					type: "boolean",
					description: "true si debes tenerlo siempre presente (su nombre, gustos, proyectos): además se apunta en MEMORY.md",
				},
			},
			required: ["content"],
		},
	},

	// ============ HABILIDADES ============
	{
		label: "Usar habilidad",
		name: "use_skill",
		description:
			'Carga las instrucciones de una habilidad de la lista "Habilidades" del sistema. Úsala antes de responder cuando una encaje con lo que pide el usuario y sigue lo que diga. Sin name, lista todas. Con file, lee otro archivo de la habilidad (referencias, plantillas).',
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Nombre de la habilidad (tal cual aparece en la lista)" },
				file: { type: "string", description: "Opcional: archivo dentro de la habilidad, p. ej. references/guia.md" },
			},
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

	// ============ GIT ============
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

	// ============ CONTROL DEL PC ============
	{
		label: "Abrir en el PC",
		name: "pc_open",
		description:
			"Abre en el PC del usuario una aplicación por su nombre ('Spotify', 'Calculadora', 'Chrome', 'Discord'), una web en SU navegador normal ('youtube.com' o URL completa; si pide 'tu navegador' usa browser), una carpeta ('Descargas', 'Documentos', 'C:/ruta') o un archivo. Para buscar en YouTube abre https://www.youtube.com/results?search_query=... y en Google https://www.google.com/search?q=...",
		category: "pc",
		parameters: {
			type: "object",
			properties: { target: { type: "string", description: "Qué abrir: nombre de la app, URL, carpeta o ruta de archivo" } },
			required: ["target"],
		},
		examples: [
			'"abre spotify" → pc_open({target: "Spotify"})',
			'"pon lofi en youtube" → pc_open({target: "https://www.youtube.com/results?search_query=lofi"})',
			'"abre mis descargas" → pc_open({target: "Descargas"})',
		],
	},
	{
		label: "Captura de pantalla",
		name: "pc_screenshot",
		description: "Toma una captura de la pantalla del PC para ver qué hay abierto. Úsala antes de hacer clic con pc_mouse.",
		category: "pc",
		parameters: { type: "object", properties: {} },
	},
	{
		label: "Teclado",
		name: "pc_keyboard",
		description:
			"Escribe texto y/o pulsa teclas en el PC, en la ventana indicada con 'window' (recomendado) o en la activa. Primero escribe 'text' y después pulsa 'keys'. Ejemplos de keys: 'enter', 'ctrl+c', 'ctrl+v', 'alt+tab', 'win+d', 'ctrl+a, supr'.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "Texto a escribir tal cual" },
				keys: { type: "string", description: "Teclas o atajos a pulsar, separados por comas" },
				window: { type: "string", description: "Ventana donde escribir (ej: 'Bloc de notas', 'Chrome'); se trae al frente antes" },
			},
		},
		examples: ['"escribe hola en el bloc de notas" → pc_keyboard({window: "Bloc de notas", text: "hola"})'],
	},
	{
		label: "Ratón",
		name: "pc_mouse",
		description:
			"Mueve el ratón, hace clic o desplaza la página. x e y son píxeles de la última captura de pantalla (toma una con pc_screenshot antes). Sin x/y actúa donde esté el puntero.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["click", "double_click", "right_click", "move", "scroll_up", "scroll_down"] },
				x: { type: "number", description: "Posición horizontal en la captura" },
				y: { type: "number", description: "Posición vertical en la captura" },
				amount: { type: "number", description: "Pasos de scroll (por defecto 3)" },
			},
			required: ["action"],
		},
	},
	{
		label: "Volumen y música",
		name: "pc_media",
		description:
			"Controla el volumen y la reproducción del PC (Spotify, YouTube, etc.): subir, bajar o fijar el volumen, silenciar, reproducir/pausar, siguiente o anterior canción.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["volume_up", "volume_down", "set_volume", "get_volume", "mute", "unmute", "play_pause", "next", "previous", "stop"],
				},
				value: { type: "number", description: "Porcentaje: volumen exacto para set_volume, o cuánto subir/bajar (por defecto 10)" },
			},
			required: ["action"],
		},
		examples: ['"pon el volumen al 30" → pc_media({action: "set_volume", value: 30})', '"siguiente canción" → pc_media({action: "next"})'],
	},
	{
		label: "Ventanas",
		name: "pc_windows",
		description: "Gestiona las ventanas abiertas: listarlas, traer una al frente, minimizar, maximizar, restaurar, cerrar o mostrar el escritorio.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "focus", "minimize", "maximize", "restore", "close", "show_desktop"] },
				title: { type: "string", description: "Nombre de la app o parte del título de la ventana (ej: 'Spotify', 'Chrome')" },
			},
			required: ["action"],
		},
	},
	{
		label: "Programas en ejecución",
		name: "pc_processes",
		description: "Lista los programas en ejecución y la memoria que usan, o cierra a la fuerza uno que no responde (kill).",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "kill"] },
				name: { type: "string", description: "Nombre del proceso (ej: chrome, spotify)" },
			},
			required: ["action"],
		},
	},
	{
		label: "Portapapeles",
		name: "pc_clipboard",
		description: "Lee el texto copiado en el portapapeles o copia un texto nuevo en él.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "write"] },
				text: { type: "string", description: "Texto a copiar (para write)" },
			},
			required: ["action"],
		},
	},
	{
		label: "Estado del PC",
		name: "pc_system",
		description: "Estado del PC: uso de CPU y RAM, espacio libre en disco, batería y tiempo encendido.",
		category: "pc",
		parameters: { type: "object", properties: {} },
	},
	{
		label: "Energía",
		name: "pc_power",
		description:
			"Bloquea, suspende, apaga o reinicia el PC, cierra la sesión, o cancela un apagado programado. Úsalo solo si el usuario lo pide claramente.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["lock", "sleep", "shutdown", "restart", "logoff", "cancel"] },
				delay_minutes: { type: "number", description: "Minutos de espera antes de apagar/reiniciar (por defecto 1)" },
			},
			required: ["action"],
		},
	},

	{
		label: "Navegador",
		name: "browser",
		description:
			"Tu propio navegador web (\"tu navegador\": el usuario lo ve en vivo en el panel Navegador). Acciones: open (abre una dirección o busca un texto en internet), read (lee la página: texto y elementos numerados [n]), click (pulsa el elemento ref), type (escribe text en el campo ref; enter=true para enviar), scroll (direction up/down), back (página anterior), screenshot (captura), close. open, click, type, scroll y back devuelven la página actualizada con números nuevos.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["open", "read", "click", "type", "scroll", "back", "screenshot", "close"] },
				url: { type: "string", description: "Para open: dirección (youtube.com, https://...) o texto a buscar" },
				ref: { type: "number", description: "Para click/type: número [n] del elemento en la última lectura" },
				text: { type: "string", description: "Para type: texto a escribir (reemplaza lo que hubiera)" },
				enter: { type: "boolean", description: "Para type: pulsar Enter después (enviar/buscar)" },
				direction: { type: "string", enum: ["up", "down"], description: "Para scroll" },
			},
			required: ["action"],
		},
		examples: [
			'"busca vuelos a Madrid" → browser({action: "open", url: "vuelos a Madrid"})',
			'"entra en wikipedia" → browser({action: "open", url: "wikipedia.org"}) y luego browser({action: "click", ref: 3})',
		],
	},
	{
		label: "Terminal",
		name: "terminal",
		description:
			"Terminal (PowerShell en Windows) compartida con el usuario, visible en el panel Terminal. read: ver lo último que hay (comandos del usuario y su salida, errores). run: ejecutar un comando a la vista del usuario y recibir su salida. stop: detener lo que se esté ejecutando.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "run", "stop"] },
				command: { type: "string", description: "Para run: el comando" },
				lines: { type: "number", description: "Para read: cuántas líneas finales ver (por defecto 80)" },
				timeout_seconds: { type: "number", description: "Para run: segundos máximos de espera (por defecto 60)" },
			},
			required: ["action"],
		},
		examples: [
			'"mira qué error sale en la terminal" → terminal({action: "read"})',
			'"instala las dependencias" → terminal({action: "run", command: "npm install"})',
		],
	},

	// ============ PROYECTOS ============
	{
		label: "Archivos del proyecto",
		name: "project",
		description:
			"Archivos del proyecto de este chat (documentos subidos y carpetas vinculadas; lee texto, PDF y Word). list: ver los archivos (opcional path de una carpeta). read: leer un archivo (path; si es largo, sigue con offset). search: buscar palabras en todos los archivos (query; opcional path para buscar solo en una carpeta). write: crear o cambiar un archivo de texto (path, content; pide permiso al usuario). Las rutas empiezan por el nombre de la carpeta del proyecto, p. ej. Subidos/informe.pdf.",
		category: "archivos",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "read", "search", "write"] },
				path: { type: "string", description: "Ruta dentro del proyecto (ej: Subidos/informe.pdf)" },
				query: { type: "string", description: "Para search: palabras a buscar" },
				offset: { type: "number", description: "Para read: carácter desde el que seguir leyendo" },
				content: { type: "string", description: "Para write: contenido completo del archivo" },
			},
			required: ["action"],
		},
		examples: [
			'"¿qué dice el contrato sobre el pago?" → project({action: "search", query: "pago"})',
			'"resume el informe" → project({action: "read", path: "Subidos/informe.pdf"})',
		],
	},
];

/**
 * Herramientas esenciales para el perfil "lite" (modelos locales pequeños):
 * con menos opciones el modelo elige mejor y el prompt ocupa menos contexto.
 */
export const LITE_TOOLS = [
	"read_file",
	"write_file",
	"list_dir",
	"search_web",
	"fetch_url",
	"calculator",
	"get_time",
	"create_reminder",
	"list_reminders",
	"memory_search",
	"memory_add",
	"use_skill",
	"exec",
	"pc_open",
	"pc_media",
	"pc_windows",
	"pc_keyboard",
	"pc_screenshot",
	"pc_system",
	"pc_power",
	"browser",
	"terminal",
	"project",
];

/** Herramientas que controlan el PC (se pueden desactivar todas con `pcControl: false`). */
export const PC_TOOLS = TOOLS.filter((t) => t.category === "pc").map((t) => t.name);

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
				read: `Leyendo ${short(a.path)}`,
				search: `Buscando en el proyecto: ${short(a.query)}`,
				write: `Escribiendo ${short(a.path)}`,
			};
			return labels[String(a.action)] ?? "Usando los archivos del proyecto";
		}
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
		case "terminal":
			return a.action === "run" ? `Ejecutando en la terminal: ${short(a.command)}` : a.action === "stop" ? "Deteniendo la terminal" : "Mirando la terminal";
		default: {
			const mcp = isMcpToolName(name) ? mcpManager.lookup(name) : undefined;
			if (mcp) return `Usando ${mcp.tool} (${mcp.server})`;
			return getToolDefinition(name)?.label ?? name;
		}
	}
}

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
		return mcpManager.callTool(name, args);
	}
	if (Array.isArray(allowedTools) && !allowedTools.includes(name)) {
		return { ok: false, error: "Herramienta no permitida en esta sesion: " + name };
	}
	const approval = await requestApproval(name, args);
	if (!approval.ok) return { ok: false, error: approval.error };
	return executeTool(name, args);
}
