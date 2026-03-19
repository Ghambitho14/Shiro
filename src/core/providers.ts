/**
 * Providers - Inyección de dependencias para Shiro
 * Centraliza la creación de componentes del sistema
 */

import type { LLMClient } from "./llm/LLMClient.js";
import type { MemoryStore } from "./memory/MemoryStore.js";
import type { SessionMemoryStoreHandle } from "./memory/SessionMemoryStore.js";
import type { ToolDef } from "./llm/LLMClient.js";
import { getLLM } from "./llm/getLLM.js";
import { createSessionMemoryStore } from "./memory/SessionMemoryStore.js";
import { getToolsDefinition, setToolsEnabled } from "./tools/ToolRegistry.js";
import { getConfig } from "../config/config.js";

// ============= LLM Provider =============

let llmClient: LLMClient | null = null;

export function getLLMClient(): LLMClient {
	if (!llmClient) {
		llmClient = getLLM();
	}
	return llmClient;
}

export function setLLMClient(client: LLMClient): void {
	llmClient = client;
}

// ============= Memory Provider =============

let sessionStore: SessionMemoryStoreHandle | null = null;

export function getSessionMemoryStore(): SessionMemoryStoreHandle {
	if (!sessionStore) {
		sessionStore = createSessionMemoryStore();
	}
	return sessionStore;
}

export function getMemoryStore(sessionId: string = "default"): MemoryStore {
	return getSessionMemoryStore().getMemory(sessionId);
}

export function setSessionMemoryStore(store: SessionMemoryStoreHandle): void {
	sessionStore = store;
}

// ============= Tools Provider =============

export function getTools(): ToolDef[] {
	return getToolsDefinition(true);
}

export function setToolsEnabledByName(names: string[], enabled: boolean): void {
	setToolsEnabled(names, enabled);
}

// ============= Config Provider =============

export function getAppConfig() {
	return getConfig();
}

// ============= All Providers =============

export interface Providers {
	llm: LLMClient;
	memory: (sessionId?: string) => MemoryStore;
	tools: ToolDef[];
	config: ReturnType<typeof getAppConfig>;
}

export function getAllProviders(): Providers {
	return {
		llm: getLLMClient(),
		memory: getMemoryStore,
		tools: getTools(),
		config: getAppConfig(),
	};
}

// ============= Factory =============

export interface AgentDeps {
	llm: LLMClient;
	memory: MemoryStore;
	tools: ToolDef[];
	tokenBudget: number;
	allowedTools?: string[];
}

export function createAgentDependencies(sessionId: string = "default"): AgentDeps {
	const config = getAppConfig();
	const llm = getLLMClient();
	const memory = getMemoryStore(sessionId);
	const tools = getTools();
	
	return {
		llm,
		memory,
		tools,
		tokenBudget: 8000, // Default, configurable por sesión
		allowedTools: undefined, // Todas las tools disponibles
	};
}