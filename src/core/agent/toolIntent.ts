/**
 * Modo ahorro: solo se le ofrecen al modelo las herramientas que parecen hacer falta para lo que
 * pidió el usuario (palabras clave, sin modelo). Cada herramienta ocupa tokens en cada vuelta, y
 * todas juntas son unos 4.800. Las de servidores MCP y las desconocidas se dejan siempre.
 */
import { normalizeText } from "../agents/text.js";

/** Siempre disponibles: baratas y útiles para casi cualquier pregunta. */
const ALWAYS = ["calculator", "get_time", "search_web", "fetch_url", "memory_search", "memory_add", "use_skill", "project", "delegate"];

/** Grupos que solo entran si el mensaje habla de ello. `words` se mira sobre el texto sin tildes. */
const GROUPS: { tools: string[]; words: RegExp; raw?: RegExp }[] = [
	{
		tools: ["read_file", "write_file", "list_dir", "read_file_system", "write_file_system", "list_dir_system", "describe_image"],
		words: /\b(archivos?|carpetas?|documentos?|ficheros?|lee|leer|leelo|leeme|escrib\w*|guard\w*|txt|pdf|docx?|csv|json|ruta|escritorio|descargas|imagen(es)?|fotos?|notas?|crea\w*)\b/,
		raw: /\b\w+\.(txt|md|pdf|docx?|csv|json|js|ts|py|html?|xlsx?)\b|[a-z]:[\\/]/i,
	},
	{
		tools: ["create_reminder", "list_reminders", "complete_reminder", "cron_create", "cron_list", "cron_delete", "cron_toggle"],
		words: /\b(recuerd\w*|recordatorios?|avis\w*|alarmas?|programa\w*|cada (dia|semana|hora|mes|lunes|martes|miercoles|jueves|viernes|sabado|domingo)|manana|a las \d+|en \d+ (minutos?|horas?)|tareas?|pendientes?)\b/,
	},
	{ tools: ["get_weather"], words: /\b(clima|tiempo hace|temperatura|llueve|lluvia|llover|pronostico|calor|frio|grados)\b/ },
	{
		tools: ["pc_open", "pc_screenshot", "pc_keyboard", "pc_mouse", "pc_media", "pc_windows", "pc_processes", "pc_clipboard", "pc_system", "pc_power", "exec", "terminal"],
		words:
			/\b(pc|computador\w*|ordenador|equipo|windows|abr\w*|cierr\w*|cerrar|ventanas?|volumen|musica|cancion\w*|reproduc\w*|pausa|siguiente|spotify|youtube|videos?|captura\w*|pantalla|ves|mira|apag\w*|reinici\w*|suspend\w*|bloque\w*|teclado|teclas?|raton|mouse|clic|procesos?|portapapeles|copi\w*|peg\w*|comandos?|terminal|powershell|consola|instal\w*|ejecut\w*|bateria|ram|cpu|disco|aplicacion\w*|apps?)\b/,
	},
	{
		tools: ["browser"],
		words: /\b(navegador|naveg\w*|paginas?|sitios?|entr\w*|sesion|login|formularios?|clic|puls\w*|botones?|boton|links?|enlaces?|chrome|edge|compr\w*|reserv\w*)\b/,
		raw: /https?:\/\/|www\./i,
	},
	{ tools: ["git"], words: /\b(git|commits?|ramas?|repo\w*|diff|push|cambios)\b/ },
	{ tools: ["sessions_list", "sessions_history"], words: /\b(chats? anterior\w*|conversacion\w* anterior\w*|otros? chats?|otra conversacion|historial|hablamos|dijimos)\b/ },
	{ tools: ["claude_code"], words: /\b(claude|codigo|program\w*|bugs?|errores?|error|funcion\w*|arregl\w*|implement\w*|proyecto|refactor\w*)\b/ },
];

const KNOWN = new Set([...ALWAYS, ...GROUPS.flatMap((g) => g.tools)]);

/**
 * Las herramientas de `available` que tocan para estos textos (el mensaje nuevo y los últimos del
 * chat, para que "sí, hazlo" siga teniendo las de antes). Nunca devuelve una lista vacía si
 * `available` no lo era.
 */
export function selectToolsByIntent(available: string[], texts: string[]): string[] {
	const raw = texts.join("\n");
	const text = normalizeText(raw);
	const wanted = new Set(ALWAYS);
	for (const g of GROUPS) {
		if (g.words.test(text) || g.raw?.test(raw)) for (const t of g.tools) wanted.add(t);
	}
	const out = available.filter((t) => !KNOWN.has(t) || wanted.has(t));
	return out.length ? out : available;
}
