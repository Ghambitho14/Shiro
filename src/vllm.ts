/** Re-export para compatibilidad. Usar core/llm en código nuevo. */
import type { Message } from "./core/agent/Types.js";
import { vllmClient } from "./core/llm/vllmClient.js";
export type { Message };
export { vllmClient, vllmClient as chat };

export async function chatWithTools(
	messages: Message[],
	toolsDef: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>,
	executeTool: (name: string, args: Record<string, unknown>) => { ok: boolean; content: string; error?: string },
): Promise<string> {
	return vllmClient.chatWithTools(messages, toolsDef as import("./core/llm/LLMClient.js").ToolDef[], executeTool);
}

export function getVllmConfig(): { baseUrl: string; model: string } {
	return vllmClient.getConfig();
}
