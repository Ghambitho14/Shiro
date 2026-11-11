import type { ToolResult } from "../agent/Types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import { executeTool } from "./tools.js";
import { noteExternalRead, requestApproval } from "./approval.js";
import { isExternalTool } from "./untrusted.js";
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
			properties: {
				path: { type: "string", description: "Ruta relativa al workspace (ej: notas.txt, docs/README.md)" },
				line: { type: "number", description: "Opcional: primera línea a leer (si el archivo es largo)" },
				lines: { type: "number", description: "Opcional: cuántas líneas leer" },
			},
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
		description: "Lee un archivo de la PC del usuario (ruta absoluta). Si es largo llega por partes: sigue con line (y lines) como diga el resultado.",
		category: "sistema",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Ruta absoluta (C:/...)" },
				line: { type: "number", description: "Opcional: primera línea a leer" },
				lines: { type: "number", description: "Opcional: cuántas líneas leer" },
			},
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
			"Obtiene el contenido textual de una URL (HTML, JSON, XML). Úsalo cuando el usuario da un enlace oficial o quieres comprobar una fuente concreta; complementa a search_web. Una página larga llega por partes: sigue con offset como diga el resultado, o usa find para traer solo los párrafos que tienen unas palabras.",
		category: "web",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "URL completa (https://...)" },
				offset: { type: "number", description: "Opcional: letra desde la que seguir leyendo (te la da el resultado anterior)" },
				find: { type: "string", description: "Opcional: palabras a buscar en la página; devuelve solo los párrafos que las tienen" },
			},
			required: ["url"],
		},
	},
	{
		label: "Buscar CVE",
		name: "cve_search",
		description:
			"Busca vulnerabilidades (CVE) en la base de datos de CIRCL. Úsalo en pruebas de seguridad para saber qué fallos afectan a un software y su versión. Dos formas: por id (un CVE concreto, p. ej. CVE-2024-3094) o por producto (product, y opcional vendor, p. ej. vendor=openbsd product=openssh). Devuelve CVSS, resumen, productos afectados y referencias.",
		category: "web",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Un CVE concreto, formato CVE-AAAA-NNNN (ej: CVE-2024-3094)" },
				vendor: { type: "string", description: "Fabricante del producto (ej: openbsd, apache)" },
				product: { type: "string", description: "Nombre del producto (ej: openssh, log4j)" },
			},
		},
		examples: [
			'"qué sabes del CVE-2021-44228" → cve_search({id: "CVE-2021-44228"})',
			'"vulnerabilidades de openssh" → cve_search({vendor: "openbsd", product: "openssh"})',
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
			'Carga las instrucciones de una habilidad de la lista "Habilidades" del sistema. Úsala antes de responder cuando una encaje con lo que pide el usuario y sigue lo que diga. Sin name, lista todas. Con file, lee otro archivo de la habilidad (referencias, plantillas). Si el resultado dice que sigue, vuelve a llamarla con offset para leer el resto.',
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Nombre de la habilidad (tal cual aparece en la lista)" },
				file: { type: "string", description: "Opcional: archivo dentro de la habilidad, p. ej. references/guia.md" },
				offset: { type: "number", description: "Opcional: letra desde la que seguir leyendo (te la da el resultado anterior)" },
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
				command: { type: "string", description: "Un solo comando git (sin 'git', ej: 'status', 'add .', 'commit -m \"msg\"'). Sin &&, | ni >: haz otra llamada para el siguiente" },
				repoPath: { type: "string", description: "Ruta al repositorio (por defecto, la carpeta del proyecto del chat; si no hay, la de Aku)" },
			},
			required: ["command"],
		},
		examples: [
			'"qué cambios hay" → git({command: "status"})',
			'"haz un commit con mis cambios" → git({command: "add ."}) y luego git({command: "commit -m \"mejora\""})',
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
			"Terminal real (PowerShell en Windows, bash en Linux) compartida con el usuario, visible en el panel Terminal. read: ver lo que hay en pantalla. run: ejecutar un comando a su vista; vuelve al terminar o cuando un programa queda abierto esperando algo. write: teclear en lo que esté abierto (responder a una pregunta, manejar un programa interactivo como claude, ssh o vim). stop: detener lo que esté en marcha (Ctrl+C). Para programas interactivos: run los abre, write les escribe, read (con wait_seconds si tardan) muestra su pantalla. Contraseñas: nunca las pidas en el chat; si un programa pide una, el panel avisa al usuario, él la escribe ahí sin que tú la veas y sigues solo. Teclea una solo si el usuario te la dio expresamente.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "run", "write", "stop"] },
				command: { type: "string", description: "Para run: el comando" },
				text: { type: "string", description: "Para write: el texto que se teclea" },
				enter: { type: "boolean", description: "Para write: pulsar Enter tras el texto (por defecto sí si hay text)" },
				keys: { type: "string", description: "Para write: teclas separadas por espacios: ctrl+c, enter, esc, tab, up, down, left, right, backspace…" },
				lines: { type: "number", description: "Para read: cuántas líneas finales ver (por defecto 80)" },
				wait_seconds: { type: "number", description: "Para read: esperar hasta estos segundos a que lo que esté en marcha termine o se calle" },
				timeout_seconds: { type: "number", description: "Para run (por defecto 60) y write (por defecto 15): segundos máximos de espera" },
			},
			required: ["action"],
		},
		examples: [
			'"mira qué error sale en la terminal" → terminal({action: "read"})',
			'"instala las dependencias" → terminal({action: "run", command: "npm install"})',
			'el programa pregunta "¿continuar? [s/n]" → terminal({action: "write", text: "s"})',
			'"abre claude en la terminal y pídele X" → terminal({action: "run", command: "claude"}) y luego terminal({action: "write", text: "X"})',
		],
	},

	{
		label: "Claude Code",
		name: "claude_code",
		description:
			"Encarga una tarea de programación a Claude Code (el programa de Anthropic, con la suscripción del usuario) en una carpeta del proyecto: lee el código, lo cambia y responde qué hizo. Úsalo para arreglar errores, añadir funciones, refactorizar o explicar código grande. task: la tarea completa y concreta (qué, dónde y cómo comprobarlo), escrita para otro programador. folder: carpeta del proyecto (si hay una sola, no hace falta). continue: true para seguir la última conversación de Claude Code en esa carpeta. Tarda minutos y pide permiso al usuario.",
		category: "pc",
		parameters: {
			type: "object",
			properties: {
				task: { type: "string", description: "La tarea para Claude Code, completa y concreta" },
				folder: { type: "string", description: "Carpeta del proyecto (opcional si solo hay una)" },
				continue: { type: "boolean", description: "Seguir la conversación anterior de Claude Code en esa carpeta" },
				timeout_minutes: { type: "number", description: "Minutos máximos (por defecto 20, máximo 60)" },
			},
			required: ["task"],
		},
		examples: [
			'"que Claude Code arregle el error del login" → claude_code({task: "Arregla el error al iniciar sesión: ... Comprueba con npm test."})',
			'"sigue con lo de antes" → claude_code({task: "Sigue con la tarea anterior", continue: true})',
		],
	},

	// ============ AYUDANTES ============
	{
		label: "Repartir tareas",
		name: "delegate",
		description:
			"Crea ayudantes (subagentes) que hacen tareas a la vez, cada uno con tus mismas herramientas, y te devuelven su resultado; el usuario los ve trabajar en el panel «Oficina». Úsalo para trabajos grandes que se parten en tareas independientes (investigar varias cosas, comparar opciones, revisar varios archivos); lo simple hazlo tú. Cada task tiene que entenderse sola (el ayudante no ve la conversación): qué hacer, con qué datos y qué devolver. agent: nombre de un agente de Ajustes → Agentes; si no, name: nombre corto para un ayudante temporal. Máximo 4 tareas por llamada.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: "Las tareas, una por ayudante (máximo 4)",
					items: {
						type: "object",
						properties: {
							task: { type: "string", description: "La tarea completa y concreta, y qué debe devolver" },
							agent: { type: "string", description: "Opcional: nombre de un agente de Ajustes → Agentes" },
							name: { type: "string", description: "Opcional: nombre corto para un ayudante temporal (ej: Investigador)" },
						},
						required: ["task"],
					},
				},
				timeout_minutes: { type: "number", description: "Minutos máximos por ayudante (por defecto 5, máximo 20)" },
			},
			required: ["tasks"],
		},
		examples: [
			'"compara estos 3 portátiles" → delegate({tasks: [{name: "Portátil A", task: "Busca precio y opiniones del ... y devuelve un resumen con enlaces"}, ...]})',
		],
	},

	// ============ PROYECTOS ============
	{
		label: "Archivos del proyecto",
		name: "project",
		description:
			"Archivos del proyecto de este chat (subidos y carpetas vinculadas; lee texto, PDF y Word). Acciones: list (ver los archivos; path opcional). find (encontrar archivos por nombre: query con parte del nombre o un patrón como *.test.ts). search (buscar texto dentro de los archivos: query con palabras que estén en la misma línea, y | entre alternativas; files para limitar, p. ej. *.ts; context para ver las líneas de alrededor). read (leer path; si es largo llega por partes: line y lines para un tramo). edit (cambiar un trozo: path, old_text con el texto exacto que hay ahora y new_text con cómo debe quedar). write (crear un archivo o reescribirlo entero: path, content). edit y write piden permiso. Las rutas empiezan por la carpeta del proyecto, p. ej. Subidos/informe.pdf.",
		category: "archivos",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "find", "search", "read", "edit", "write"] },
				path: { type: "string", description: "Ruta dentro del proyecto (ej: Subidos/informe.pdf)" },
				query: { type: "string", description: "Para find: nombre o patrón. Para search: palabras a buscar" },
				files: { type: "string", description: "Para search: solo en estos archivos (ej: *.ts, src/**)" },
				context: { type: "number", description: "Para search: líneas de alrededor que se enseñan (0 a 3)" },
				line: { type: "number", description: "Para read: primera línea a leer" },
				lines: { type: "number", description: "Para read: cuántas líneas leer" },
				offset: { type: "number", description: "Para read de PDF o Word: carácter desde el que seguir" },
				old_text: { type: "string", description: "Para edit: el trozo exacto que hay ahora (único en el archivo)" },
				new_text: { type: "string", description: "Para edit: el texto que lo reemplaza" },
				replace_all: { type: "boolean", description: "Para edit: cambiar todas las veces que aparece" },
				content: { type: "string", description: "Para write: contenido completo del archivo" },
			},
			required: ["action"],
		},
		examples: [
			'"¿dónde está el login?" → project({action: "search", query: "login", files: "*.ts"})',
			'"resume el informe" → project({action: "read", path: "Subidos/informe.pdf"})',
		],
	},

	// ============ LISTA DE TAREAS ============
	{
		label: "Lista de tareas",
		name: "todo",
		description:
			"Tu lista de tareas en un trabajo de varios pasos (3 o más); el usuario la ve en el chat y se va tachando. Manda siempre la lista completa en items: cada tarea con text y status (pending, in_progress o done). Créala al empezar, deja en in_progress solo la que estás haciendo y márcala done en cuanto la termines. No la uses para preguntas simples.",
		category: "utilidades",
		parameters: {
			type: "object",
			properties: {
				items: {
					type: "array",
					description: "La lista completa, en orden",
					items: {
						type: "object",
						properties: {
							text: { type: "string", description: "La tarea, en pocas palabras" },
							status: { type: "string", enum: ["pending", "in_progress", "done"] },
						},
						required: ["text", "status"],
					},
				},
			},
			required: ["items"],
		},
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
	"cve_search",
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
	"claude_code",
];

/** Herramientas que controlan el PC (se pueden desactivar todas con `pcControl: false`). */
export const PC_TOOLS = TOOLS.filter((t) => t.category === "pc").map((t) => t.name);

/**
 * Solo funcionan en Windows (`requireWindows` en pc.ts): fuera de él el modelo ni las ve, para que
 * no pierda pasos intentándolo. pc_open y pc_system sí funcionan en Linux y macOS.
 */
export const WINDOWS_ONLY_TOOLS = ["pc_screenshot", "pc_keyboard", "pc_mouse", "pc_media", "pc_windows", "pc_processes", "pc_clipboard", "pc_power"];

/** Planear: investigar y proponer sin cambiar archivos, memoria, recordatorios ni ejecutar comandos. */
export const PLAN_TOOLS = [
	"project",
	"read_file",
	"list_dir",
	"read_file_system",
	"list_dir_system",
	"search_web",
	"fetch_url",
	"calculator",
	"get_time",
	"list_reminders",
	"memory_search",
	"use_skill",
	"sessions_list",
	"sessions_history",
	"delegate",
	"todo",
];

/**
 * Herramientas del modo Hacking (pentesting autorizado), sin los controles
 * generales del PC. La terminal es la clave: en la MV de Kali es `bash`, con acceso directo a nmap,
 * nikto, sqlmap, etc. Es una lista elegida a propósito: no pasa por el perfil lite ni el modo ahorro.
 */
export const HACKING_TOOLS = [
	"project",
	"read_file",
	"write_file",
	"list_dir",
	"read_file_system",
	"write_file_system",
	"list_dir_system",
	"terminal",
	"exec",
	"git",
	"claude_code",
	"browser",
	"fetch_url",
	"search_web",
	"cve_search",
	"calculator",
	"get_time",
	"memory_search",
	"memory_add",
	"use_skill",
	"delegate",
	"todo",
];

/**
 * Herramientas del modo Code (programar en proyectos): las de Hacking sin las de seguridad.
 * También es una lista elegida a propósito: no pasa por el perfil lite ni el modo ahorro.
 */
export const CODE_TOOLS = HACKING_TOOLS.filter((t) => t !== "cve_search");

/** Las herramientas de solo lectura al planear, según el modo. */
export function planToolsFor(mode: string): string[] {
	return mode === "hacking" ? [...PLAN_TOOLS, "cve_search"] : PLAN_TOOLS;
}

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
