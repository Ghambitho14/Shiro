/**
 * La palabra de activación («Aku») y cómo suena mal transcrita: los reconocedores a veces escriben «Haiku»,
 * «Jaiku», «Acu» u «Oyeaku». Lo usan la escucha de la bandeja (wakeListener.ts, que pasa cada frase a texto y
 * mira si empieza por la palabra) y las órdenes de sala del chat (roomTurn.ts), para que «Haiku, actívate»
 * valga como «Aku, actívate».
 */
import { normalizeText } from "../agents/text.js";

/** Cómo transcriben a veces «Aku» (sin tildes ni mayúsculas). Los primeros son los más parecidos. */
const AKU_CLOSE = ["aku", "acu", "akku"];
const AKU_SOUNDALIKES = [...AKU_CLOSE, "haiku", "jaiku", "aiku", "jaku", "haku", "a cu", "a ku"];

/** La palabra y lo que suena parecido, sin repetir. Solo «Aku» tiene parecidos conocidos. */
export function wakeVariants(word: string, close = false): string[] {
	const base = normalizeText(word);
	if (!base) return [];
	const out = [word.trim(), ...(base === "aku" ? (close ? AKU_CLOSE : AKU_SOUNDALIKES) : [])];
	const seen = new Set<string>();
	return out.filter((w) => {
		const k = normalizeText(w);
		if (!k || seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

export type WakeSensitivity = "low" | "medium" | "high";

/** Lo que se dice antes del nombre: «oye Aku», «hey Aku»… (el reconocedor a veces lo pega: «Oyeaku»). */
const GREETINGS = ["oye", "oiga", "hey", "ey", "hola", "ok", "okey"];

/**
 * ¿Esta frase llama a Aku? Tiene que empezar por la palabra (o un saludo y la palabra), para que «escribe un
 * haiku» o hablar de otra cosa no lo despierte.
 * - low: solo la palabra o lo más parecido («Aku», «Acu»), al principio.
 * - medium: también los parecidos («Haiku», «Jaiku»…), al principio.
 * - high: también en las tres primeras palabras («bueno, Aku…»).
 */
export function callsWake(text: string, word: string, sensitivity: WakeSensitivity = "medium"): boolean {
	const words = normalizeText(text).split(" ").filter(Boolean);
	if (!words.length) return false;
	const variants = wakeVariants(word, sensitivity === "low").map((v) => normalizeText(v));
	const single = new Set(variants.filter((v) => !v.includes(" ")));
	const multi = variants.filter((v) => v.includes(" ")).map((v) => v.split(" "));
	const isWakeAt = (i: number): boolean => {
		const w = words[i] ?? "";
		if (single.has(w)) return true;
		// «Oyeaku», «Heyaku»: el saludo pegado a la palabra.
		for (const g of GREETINGS) if (w.startsWith(g) && single.has(w.slice(g.length))) return true;
		return multi.some((m) => m.every((part, k) => words[i + k] === part));
	};
	const reach = sensitivity === "high" ? 3 : 1;
	for (let i = 0; i < Math.min(reach, words.length); i++) {
		if (isWakeAt(i)) return true;
		// Un saludo delante no gasta el sitio: «oye Aku» vale aunque solo se mire la primera palabra.
		if (GREETINGS.includes(words[i] ?? "") && isWakeAt(i + 1)) return true;
	}
	return false;
}
