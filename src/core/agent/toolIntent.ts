/**
 * Modo ahorro: solo se le ofrecen al modelo las herramientas que parecen hacer falta para lo que
 * pidió el usuario (palabras clave, sin modelo). Cada herramienta ocupa tokens en cada vuelta, y
 * todas juntas son unos 5.600. Las de servidores MCP y las desconocidas se dejan siempre.
 */
import { normalizeText } from "../agents/text.js";
import type { IntentGroup } from "../tools/toolDefinitions.js";
import { ALWAYS_TOOLS, toolsInGroup } from "../tools/toolPolicy.js";

/**
 * Siempre disponibles (`intent: "always"` en su `policy`): baratas y útiles para casi cualquier pregunta.
 * Incluye la terminal porque varias habilidades la necesitan (buscar-en-pc) y lo que se le pide no siempre
 * trae una palabra clave. Sigue pidiendo permiso y solo está si el control del PC está permitido (`resolveTools`).
 */
const ALWAYS = ALWAYS_TOOLS;

/**
 * Palabras de cada grupo: el grupo entra solo si el mensaje habla de ello. `words` se mira sobre el texto sin
 * tildes. Qué herramientas van en cada grupo lo dice `intent` en su `policy`; un grupo nuevo necesita aquí sus palabras.
 */
const GROUP_WORDS: Record<IntentGroup, { words: RegExp; raw?: RegExp }> = {
	archivos: {
		words: /\b(archivos?|carpetas?|documentos?|ficheros?|lee|leer|leelo|leeme|escrib\w*|guard\w*|txt|pdf|docx?|csv|json|ruta|escritorio|descargas|imagen(es)?|fotos?|notas?|crea\w*)\b/,
		raw: /\b\w+\.(txt|md|pdf|docx?|csv|json|js|ts|py|html?|xlsx?)\b|[a-z]:[\\/]/i,
	},
	recordatorios: {
		words: /\b(recuerd\w*|recordatorios?|avis\w*|alarmas?|programa\w*|cada (dia|semana|hora|mes|manana|tarde|noche|lunes|martes|miercoles|jueves|viernes|sabado|domingo)|todos los (dias|lunes|martes|miercoles|jueves|viernes|sabados|domingos)|diari\w*|semanal\w*|automatic\w*|manana|a las \d+|en \d+ (minutos?|horas?)|tareas?|pendientes?)\b/,
	},
	google: {
		words: /\b(correos?|e-?mails?|mails?|gmail|bandeja|mensajes? nuevos?|respond\w*|contest\w*|envi\w*|calendario|agenda\w*|eventos?|reunion\w*|citas?|cumpleanos|invita\w*|que tengo (hoy|manana|el|esta|la)|ocupad\w*|libre)\b/,
	},
	clima: { words: /\b(clima|tiempo hace|temperatura|llueve|lluvia|llover|pronostico|calor|frio|grados)\b/ },
	pc: {
		words:
			/\b(pc|compu|computador\w*|ordenador|laptop|portatil|equipo|windows|abr\w*|cierr\w*|cerrar|ventanas?|volumen|sonido|audio|silenci\w*|altavoc\w*|parlantes?|bocinas?|musica|cancion\w*|reproduc\w*|paus\w*|play|reanud\w*|siguiente|spotify|youtube|videos?|captura\w*|pantalla|ves|mira|apag\w*|reinici\w*|suspend\w*|bloque\w*|teclado|teclas?|raton|mouse|clic|procesos?|portapapeles|copi\w*|peg\w*|comandos?|terminal|powershell|consola|contrasen\w*|sudo|ssh|claude|instal\w*|ejecut\w*|bateria|ram|cpu|disco|aplicacion\w*|apps?)\b/,
	},
	navegador: {
		words: /\b(navegador|naveg\w*|paginas?|sitios?|entr\w*|sesion|login|formularios?|clic|puls\w*|botones?|boton|links?|enlaces?|chrome|edge|compr\w*|reserv\w*)\b/,
		raw: /https?:\/\/|www\./i,
	},
	git: { words: /\b(git|commits?|ramas?|repo\w*|diff|push|cambios)\b/ },
	chats: { words: /\b(chats? anterior\w*|conversacion\w* anterior\w*|otros? chats?|otra conversacion|historial|hablamos|dijimos)\b/ },
	// La lista de tareas solo para trabajos largos: en una pregunta normal sería ruido.
	tareas: { words: /\b(investig\w*|analiz\w*|audit\w*|revis\w*|compar\w*|paso a paso|plan\w*|organiz\w*|migr\w*|tareas?)\b/ },
	claude: { words: /\b(claude|codigo|program\w*|bugs?|errores?|error|funcion\w*|arregl\w*|implement\w*|proyecto|refactor\w*)\b/ },
};

const GROUPS = Object.entries(GROUP_WORDS).map(([group, w]) => ({ ...w, tools: toolsInGroup(group as IntentGroup) }));
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
