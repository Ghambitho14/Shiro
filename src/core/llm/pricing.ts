/**
 * Cuánto costó una respuesta (≈ dólares): tokens × el precio del modelo de models.dev (catalog.ts).
 *
 * Solo hay precio para los proveedores que cobran por token y lo publican: OpenCode Zen y OpenRouter.
 * OpenCode Go es una suscripción: el coste se calcula igual pero va marcado como «de tu plan» (es lo que
 * costaría pagando por uso, no lo que se paga). Los modelos de tu PC, Ollama Cloud y los servidores propios no
 * tienen coste. Es una estimación: no cuenta los descuentos por caché ni los precios por tramos de contexto.
 */
import { catalogPrice, lookupModel, refreshCatalog, resolveModelId } from "./catalog.js";
import type { ModelPrice } from "./modelInfo.js";
import { PROVIDER_PRESETS } from "./providers.js";

export type PriceInfo = { price: ModelPrice; /** Suscripción: no se paga por token. */ plan: boolean };

/** Proveedores de suscripción: el coste es orientativo («de tu plan»). */
const PLAN_PROVIDERS = new Set(["opencode-go"]);

/** El precio del modelo, o undefined si no tiene coste (local) o no se conoce. */
export function priceFor(provider: string, model: string): PriceInfo | undefined {
	const preset = PROVIDER_PRESETS[provider as keyof typeof PROVIDER_PRESETS];
	if (!preset || preset.local || preset.managed || !model) return undefined;
	const plan = PLAN_PROVIDERS.has(provider);
	if (preset.catalog) {
		const id = resolveModelId(preset.catalog, model.replace(/^opencode(-go)?\//i, ""));
		const price = lookupModel(preset.catalog, id)?.price;
		return price ? { price, plan } : undefined;
	}
	if (provider === "openrouter") {
		const price = catalogPrice("openrouter", model);
		// Sin catálogo todavía (nunca se usó OpenCode): se baja para la próxima respuesta, sin esperar.
		if (!price) void refreshCatalog();
		return price ? { price, plan } : undefined;
	}
	return undefined;
}

/** Dólares de unos tokens (leídos y escritos; los de pensar ya van dentro de los escritos). */
export function costOf(usage: { input: number; output: number }, price: ModelPrice): number {
	const usd = (usage.input * price.input + usage.output * price.output) / 1_000_000;
	return Math.round(usd * 1e8) / 1e8;
}
