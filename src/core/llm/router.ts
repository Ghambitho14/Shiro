/**
 * «Elegir modelo solo» (Ajustes → Modelo, `autoModel` en la config, apagado por defecto): en cada mensaje
 * decide si responde el modelo rápido (normalmente local) o el potente (normalmente en la nube), con reglas
 * simples y sin llamar a ningún modelo. Lo usa `chatApi.ts`; las salas con un agente de modelo propio no cambian.
 *
 * Potente: Code, Hacking, Planear, «Más razonamiento», imágenes, mensajes largos o con código y palabras de
 * trabajo pesado (programa, depura, analiza, compara…). Rápido: el resto, saludos y el modo voz.
 */
import { getConfig, type AppConfig } from "../../config/config.js";
import { normalizeText } from "../agents/text.js";
import type { LLMClient } from "./LLMClient.js";
import { getLLM, getLLMFor } from "./getLLM.js";
import { isGatedProvider } from "./modelGate.js";
import { lacksApiKey, PROVIDER_PRESETS, type ModelRef } from "./providers.js";

export type ModelTier = "fast" | "strong";

export type RouteInput = {
	mode: string;
	planning: boolean;
	/** «Más razonamiento» encendido en esta respuesta. */
	moreReasoning: boolean;
	voice: boolean;
	/** El mensaje trae imágenes. */
	images: boolean;
};

/** Mensajes más largos que esto van al potente. */
const LONG_MESSAGE = 600;

/** Raíces de palabras de trabajo pesado (sin tildes; se comparan con el comienzo de cada palabra). */
const HEAVY = [
	"program", "codigo", "codig", "script", "funcion", "depur", "debug", "bug", "error", "falla", "compil", "refactor", "optimiz",
	"analiz", "analisis", "compar", "calcul", "investig", "razon", "demuestr", "deduc", "resuelv", "ecuacion", "matematic",
	"diseñ", "disen", "arquitect", "estrategi", "planific", "informe", "ensayo", "redact", "traduc", "resum", "revis", "audit",
	"vulnerab", "explot", "pentest", "sql", "regex", "algoritm", "implement", "migr", "detall", "profund",
];

/** Saludos y frases cortas (solo cambia el motivo que se enseña: ya iban al rápido). */
const SMALL_TALK = /^(hola|buenas|buenos dias|buenas tardes|buenas noches|gracias|ok|vale|dale|si|no|adios|chao|que tal|como estas)\b/;

/**
 * Qué modelo conviene y por qué (el motivo va en la respuesta guardada para que se vea en el chat).
 */
export function pickTier(goal: string, input: RouteInput): { tier: ModelTier; reason: string } {
	if (input.planning) return { tier: "strong", reason: "planear" };
	if (input.mode === "code") return { tier: "strong", reason: "modo Code" };
	if (input.mode === "hacking") return { tier: "strong", reason: "modo Hacking" };
	if (input.moreReasoning) return { tier: "strong", reason: "más razonamiento" };
	if (input.images) return { tier: "strong", reason: "lleva imágenes" };
	if (input.voice) return { tier: "fast", reason: "modo voz" };
	const text = goal.trim();
	if (text.includes("```")) return { tier: "strong", reason: "lleva código" };
	if (text.length > LONG_MESSAGE) return { tier: "strong", reason: "mensaje largo" };
	const plain = normalizeText(text);
	const words = plain.split(/\s+/).filter(Boolean);
	const heavy = words.find((w) => HEAVY.some((h) => w.startsWith(normalizeText(h))));
	if (heavy) return { tier: "strong", reason: `trabajo pesado («${heavy}»)` };
	if (words.length <= 6 && SMALL_TALK.test(plain)) return { tier: "fast", reason: "charla corta" };
	return { tier: "fast", reason: "mensaje corto" };
}

/** El modelo elegido para un lado; undefined = el de Ajustes → Modelo. */
function refOf(side: AppConfig["autoModel"]["fast"]): ModelRef | undefined {
	return side?.provider ? { provider: side.provider, ...(side.model ? { model: side.model } : {}) } : undefined;
}

/** Nombre corto del modelo para enseñarlo en el chat ("qwen3:8b" o "Kimi K2 (OpenCode Go)"). */
function labelOf(llm: LLMClient): string {
	const info = llm.getConfig();
	return info.model || PROVIDER_PRESETS[info.provider as ModelRef["provider"]]?.title || info.provider;
}

export type RoutedModel = { llm: LLMClient; tier: ModelTier; reason: string; model: string };

/**
 * El modelo de esta respuesta si «Elegir modelo solo» está encendido, o null (se usa el de siempre).
 * `cfg` es para las pruebas.
 */
export function routeModel(goal: string, input: RouteInput, cfg: AppConfig = getConfig()): RoutedModel | null {
	const auto = cfg.autoModel;
	if (!auto?.enabled || (!auto.fast && !auto.strong)) return null;
	const { tier, reason } = pickTier(goal, input);
	const ref = refOf(tier === "fast" ? auto.fast : auto.strong);
	// Sin su API key en este equipo fallaría seguro («Falta la API key…»): responde el de Ajustes → Modelo.
	if (ref && lacksApiKey(ref, cfg)) {
		const llm = getLLM();
		return { llm, tier, reason: `${PROVIDER_PRESETS[ref.provider].title} no tiene clave en este equipo`, model: labelOf(llm) };
	}
	const llm = ref ? getLLMFor(ref) : getLLM();
	return { llm, tier, reason, model: labelOf(llm) };
}

/** Cómo darle su clave a un proveedor que no es el de Ajustes → Modelo. */
export function keyHint(provider: ModelRef["provider"], cfg: AppConfig = getConfig()): string {
	const preset = PROVIDER_PRESETS[provider];
	const current = PROVIDER_PRESETS[cfg.llmProvider]?.title ?? cfg.llmProvider;
	return preset.apiKeyEnv
		? `Ponla en la variable de entorno ${preset.apiKeyEnv} de Windows y vuelve a abrir Aku (la de Ajustes → Modelo solo vale para ${current}).`
		: `Solo funciona si es el proveedor de Ajustes → Modelo (ahora es ${current}).`;
}

/**
 * Avisos de la configuración para Ajustes: los dos son locales (cada cambio recarga el modelo en la tarjeta)
 * o un modelo de la nube que no es el de Ajustes y no tiene clave (solo vale la de su variable de entorno).
 */
export function autoModelWarnings(cfg: AppConfig = getConfig(), env: NodeJS.ProcessEnv = process.env): string[] {
	const auto = cfg.autoModel;
	if (!auto) return [];
	const out: string[] = [];
	const sides = [
		["rápido", auto.fast],
		["potente", auto.strong],
	] as const;
	const providerOf = (s: (typeof sides)[number][1]) => s?.provider ?? cfg.llmProvider;
	// Solo Ollama, LM Studio y el llama.cpp integrado tienen un modelo cargado a la vez (modelGate.ts).
	const gated = (s: (typeof sides)[number][1]) => isGatedProvider(providerOf(s));
	const sameModel = providerOf(auto.fast) === providerOf(auto.strong) && (auto.fast?.model ?? "") === (auto.strong?.model ?? "");
	if (gated(auto.fast) && gated(auto.strong) && !sameModel) {
		out.push("Los dos modelos son de tu PC: cada vez que cambie de uno a otro tendrá que cargarlo en la tarjeta (unos segundos).");
	}
	for (const [name, side] of sides) {
		if (!side?.provider || side.provider === cfg.llmProvider) continue;
		const preset = PROVIDER_PRESETS[side.provider];
		if (lacksApiKey(side, cfg, env)) {
			out.push(`El modelo ${name} (${preset.title}) no tiene API key en este equipo: mientras falte, responde el de Ajustes → Modelo. ${keyHint(side.provider, cfg)}`);
		}
	}
	return out;
}
