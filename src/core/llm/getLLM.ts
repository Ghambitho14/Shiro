import type { LLMClient } from "./LLMClient.js";
import { createLLMClient } from "./client.js";

let client: LLMClient | null = null;

/** Cliente del modelo configurado. Lee la configuración en cada petición, así que los cambios aplican al momento. */
export function getLLM(): LLMClient {
	client ??= createLLMClient();
	return client;
}
