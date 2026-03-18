import type { LLMClient } from "./LLMClient.js";
import { vllmClient } from "./vllmClient.js";
import { ollamaClient } from "./ollamaClient.js";
import { openrouterClient } from "./openrouterClient.js";
import { getConfig } from "../../config/config.js";

export function getLLM(): LLMClient {
	const cfg = getConfig();
	const provider = cfg.llmProvider ?? "vllm";
	
	if (provider === "ollama") {
		return ollamaClient;
	}
	
	if (provider === "openrouter") {
		return openrouterClient;
	}
	
	return vllmClient;
}
