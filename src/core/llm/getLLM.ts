import type { LLMClient } from "./LLMClient.js";
import { createLLMClient, createLLMClientFor } from "./client.js";
import type { ModelRef } from "./providers.js";
import { currentProvider } from "./providers.js";

let client: LLMClient | null = null;

/** Cliente del modelo configurado. Lee la configuración en cada petición, así que los cambios aplican al momento. */
export function getLLM(): LLMClient {
	client ??= createLLMClient();
	return client;
}

const byModel = new Map<string, LLMClient>();

type ModelChoice = { provider?: ModelRef["provider"]; model?: string; baseUrl?: string } | null | undefined;

/** El modelo propio de un agente, o undefined si usa el de Ajustes → Modelo. */
export function profileModelRef(profile: ModelChoice): ModelRef | undefined {
	if (!profile || (!profile.provider && !profile.model)) return undefined;
	const ref: ModelRef = { provider: profile.provider ?? currentProvider(), model: profile.model, baseUrl: profile.baseUrl };
	return ref.provider === currentProvider() && !ref.model && !ref.baseUrl ? undefined : ref;
}

/**
 * Cliente del modelo de un agente. Sin proveedor ni modelo propio (o el mismo que Ajustes → Modelo)
 * es el de siempre, así sigue los cambios de Ajustes al momento.
 */
export function getLLMFor(profile?: ModelChoice): LLMClient {
	const ref = profileModelRef(profile);
	if (!ref) return getLLM();
	const key = `${ref.provider}|${ref.model ?? ""}|${ref.baseUrl ?? ""}`;
	let c = byModel.get(key);
	if (!c) {
		c = createLLMClientFor(ref);
		byModel.set(key, c);
	}
	return c;
}
