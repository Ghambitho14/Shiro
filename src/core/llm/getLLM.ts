import type { LLMClient } from "./LLMClient.js";
import { vllmClient } from "./vllmClient.js";

/**
 * Single entry point for the LLM client. For now returns the vLLM client.
 * Future: can read config/env and return a different adapter (Ollama, OpenAI, etc.).
 */
export function getLLM(): LLMClient {
	return vllmClient;
}
