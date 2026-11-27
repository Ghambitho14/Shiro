/**
 * Memoria automática (idea de OpenJarvis): después de cada respuesta, el mismo modelo lee lo que dijo el
 * usuario y lo que respondió Aku y apunta, como recuerdos, los datos que valen para siempre (gustos, quién es,
 * dónde vive, metas, proyectos, personas). Así lo importante se guarda aunque el modelo nunca llame a
 * `memory_add` (los modelos chicos casi nunca lo hacen). El recuerdo automático (`recallMemories`) ya los trae.
 *
 * Corre en segundo plano y nunca frena ni rompe la respuesta: una extracción a la vez, con tiempo máximo y
 * sin lanzar errores. Se apaga en Ajustes → Datos («Aprender de lo que hablamos», `autoMemory`).
 */
import { getConfig } from "../../config/config.js";
import type { LLMClient } from "../llm/LLMClient.js";
import type { Message } from "../agent/Types.js";
import { logger } from "../logger.js";
import { addMemory, findSimilarMemory, keywords, UNTRUSTED_TAG, type Memory } from "./memories.js";
import { looksLikeInjection } from "./memoryTrust.js";

/** Etiqueta de los recuerdos que apunta Aku solo (para distinguirlos de los que pidió el usuario). */
export const AUTO_MEMORY_TAG = "auto";
/** Como mucho tantos hechos por respuesta: la mayoría de las respuestas no dejan ninguno. */
const MAX_FACTS = 3;
const FACT_MIN_CHARS = 8;
const FACT_MAX_CHARS = 300;
/** Lo que se le manda al modelo de cada lado de la charla. */
const TEXT_MAX_CHARS = 4000;
/** Tiempo máximo de una extracción (un modelo local lento no debe quedar trabajando para siempre). */
const EXTRACT_TIMEOUT_MS = 90_000;

export type ExtractInput = {
	/** Lo que escribió el usuario. */
	goal: string;
	/** Lo que respondió Aku. */
	reply: string;
	/** Nombre del usuario, si se sabe («Sobre ti»), para escribir los hechos con su nombre. */
	userName?: string;
	/** En esta respuesta se leyó contenido de afuera (webs, correos, MCP). */
	externalRead: boolean;
	llm: LLMClient;
	sessionId?: string;
};

function clip(text: string): string {
	const t = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
	return t.length > TEXT_MAX_CHARS ? t.slice(0, TEXT_MAX_CHARS) + "…" : t;
}

export function extractPrompt(goal: string, reply: string, userName?: string): Message[] {
	const who = userName?.trim() || "el usuario";
	return [
		{
			role: "system",
			content: `Lees un intercambio entre ${who} y su asistente y sacas solo los datos sobre ${who} que valga la pena recordar durante meses: quién es, dónde vive, a qué se dedica, sus gustos y preferencias (también cómo quiere que el asistente trabaje), sus metas, sus proyectos y las personas de su vida.
Responde SOLO con una lista JSON de frases cortas en español, en tercera persona, que empiecen por «${who}», cada una entendible sola.
Reglas:
- Casi siempre la respuesta correcta es [] (lista vacía): saludos, preguntas sueltas, tareas del momento y datos generales no se guardan.
- Solo lo que ${who} dijo o confirmó; nunca lo que supuso o propuso el asistente, ni nada que no esté en el texto.
- Nunca copies contraseñas, claves, tokens, números de tarjeta ni otros secretos.
- Como mucho ${MAX_FACTS} frases.`,
		},
		{
			role: "user",
			content: `${who} escribió:\n${clip(goal)}\n\nEl asistente respondió:\n${clip(reply)}\n\nLista JSON:`,
		},
	];
}

/**
 * Las frases de la respuesta del modelo: la lista JSON, o las frases entre comillas si la lista quedó
 * cortada (los modelos chicos se alargan hasta el tope de tokens). Sin lista, []. Todavía sin filtrar.
 */
export function parseFacts(raw: string): string[] {
	const text = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "");
	const start = text.indexOf("[");
	if (start < 0) return [];
	const end = text.lastIndexOf("]");
	let items: unknown[] | null = null;
	try {
		const data: unknown = end > start ? JSON.parse(text.slice(start, end + 1)) : null;
		if (Array.isArray(data)) items = data;
	} catch {
		// abajo
	}
	// Cortada o con basura: se rescatan las frases completas entre comillas.
	items ??= [...text.slice(start).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
	const facts = items
		.filter((f): f is string => typeof f === "string")
		.map((f) => f.replace(/\s+/g, " ").trim())
		.filter((f) => f.length >= FACT_MIN_CHARS && f.length <= FACT_MAX_CHARS);
	return [...new Set(facts)];
}

/** Palabras que delatan un secreto, o una cadena de letras y números que parece una clave. */
const SECRET_HINT = /contrase|password|passwd|clave|token|api.?key|\bpin\b|tarjeta|cvv|\b(?=\w*\d)(?=\w*[a-z])\w{8,}\b/i;

/**
 * Lo que no es un dato: preguntas, huecos «[no especificado]», «no se menciona…» y el mensaje copiado
 * tal cual («Jhon: hola, ¿cómo estás?»).
 */
const NOT_A_FACT = /[?¿[\]]|^\S+:\s|\bno (se )?(especific|menciona|proporciona|indica|dice)/i;

/**
 * Si el usuario habla de sí mismo (yo, me, mi, soy, tengo, vivo, prefiero…). Sin eso no hay datos suyos que
 * apuntar: las preguntas sueltas («¿cuál es la capital de Australia?») ni se le pasan al modelo.
 */
const ABOUT_ME =
	/\b(yo|me|mi|mis|m[ií]os?|m[ií]as?|conmigo|soy|estoy|tengo|vivo|trabajo|estudio|prefiero|quiero|necesito|odio|amo|uso|llamo|nac[ií]|cumplo|i|i'm|my|me)\b/i;
export function talksAboutSelf(goal: string): boolean {
	return ABOUT_ME.test(goal);
}

/** Raíz corta de una palabra (4 letras): «prefiero» y «prefiere», «corto» y «cortas» cuentan como la misma. */
const stem = (w: string) => w.slice(0, 4);

/**
 * Si un hecho se puede creer: habla del usuario (lleva su nombre, o «usuario») y la mayoría de sus palabras
 * están en lo que el usuario escribió. Los modelos chicos inventan datos o copian los de las instrucciones;
 * esto los deja fuera sin depender del modelo. También fuera lo que parezca un secreto.
 */
export function isGroundedFact(fact: string, goal: string, userName?: string): boolean {
	if (SECRET_HINT.test(fact) || NOT_A_FACT.test(fact)) return false;
	const nameWords = new Set(keywords(userName?.trim() || "usuario"));
	const factWords = keywords(fact);
	if (![...nameWords].some((n) => factWords.includes(n))) return false;
	const own = factWords.filter((w) => !nameWords.has(w));
	if (!own.length) return false;
	const said = new Set(keywords(goal).map(stem));
	return own.filter((w) => said.has(stem(w))).length / own.length >= 0.5;
}

/**
 * Saca los hechos de un intercambio y guarda los que no estén ya. Devuelve los recuerdos nuevos.
 * Lanza si el modelo falla (quien la llama en segundo plano lo atrapa).
 */
export async function extractMemories(input: ExtractInput, signal?: AbortSignal): Promise<Memory[]> {
	// «hola», «gracias», «ok»: nada que aprender, y así no se gasta una vuelta con el modelo.
	if (keywords(input.goal).length < 2 || !talksAboutSelf(input.goal)) return [];
	// La respuesta trae órdenes escondidas: al modelo lo pudieron manipular, nada de lo que diga se guarda.
	if (looksLikeInjection(input.reply)) return [];
	// Cuarentena: tras leer una web o un correo, o si el mensaje parece traer órdenes (texto pegado de afuera),
	// lo que se apunte se guarda como «no verificado» y el recuerdo automático no lo trae.
	const doubtful = input.externalRead || looksLikeInjection(input.goal);
	const raw = await input.llm.chat(extractPrompt(input.goal, input.reply, input.userName), {
		thinking: "off",
		maxTokens: 250,
		signal,
		sessionId: input.sessionId,
	});
	const facts = parseFacts(raw)
		.filter((f) => isGroundedFact(f, input.goal, input.userName))
		.slice(0, MAX_FACTS);
	const saved: Memory[] = [];
	for (const fact of facts) {
		const untrusted = doubtful || looksLikeInjection(fact);
		// Uno confirmado ya cubre al dudoso; uno dudoso no impide guardar el confirmado.
		if (await findSimilarMemory(fact, undefined, undefined, !untrusted)) continue;
		const tags = untrusted ? [AUTO_MEMORY_TAG, UNTRUSTED_TAG] : [AUTO_MEMORY_TAG];
		saved.push(await addMemory({ content: fact, type: "observation", tags }));
	}
	return saved;
}

let running = false;

/**
 * Lo que llama `runAgent` al terminar una respuesta: no espera nada ni lanza nunca.
 * Si hay otra extracción en marcha (dos chats a la vez), esta se salta.
 */
export function learnInBackground(input: ExtractInput): void {
	if (!getConfig().autoMemory || running) return;
	running = true;
	extractMemories(input, AbortSignal.timeout(EXTRACT_TIMEOUT_MS))
		.then((saved) => {
			if (saved.length) logger.info(`Memoria automática: ${saved.length} recuerdo(s) nuevo(s)`);
		})
		.catch((err) => logger.warn(`Memoria automática: no se pudo apuntar (${err instanceof Error ? err.message : String(err)})`))
		.finally(() => {
			running = false;
		});
}

/** Para las pruebas: si hay una extracción en marcha. */
export function autoMemoryBusy(): boolean {
	return running;
}
