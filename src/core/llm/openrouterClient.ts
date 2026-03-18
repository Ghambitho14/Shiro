import type { LLMClient, ToolDef, ExecuteToolFn } from "./LLMClient.js";
import type { Message } from "../agent/Types.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { getConfig } from "../../config/config.js";

function getOpenRouterSettings(): { baseUrl: string; apiKey: string; model: string } {
	const config = getConfig();
	const baseUrl = config.openrouterBaseUrl ?? "https://openrouter.ai/api/v1";
	const apiKey = config.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "";
	const model = config.openrouterModel ?? "openai/gpt-4o-mini";
	return { baseUrl, apiKey, model };
}

function messageToContent(msg: Message): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c.filter(p => p.type === "text").map(p => "text" in p ? p.text : "").join("");
	}
	return "";
}

export const openrouterClient: LLMClient = {
	async chat(messages: Message[]): Promise<string> {
		const { baseUrl, apiKey, model } = getOpenRouterSettings();
		
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
				"HTTP-Referer": "https://shiro.ai",
				"X-Title": "Shiro",
			},
			body: JSON.stringify({
				model,
				messages: messages.map(m => ({
					role: m.role,
					content: messageToContent(m),
				})),
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`OpenRouter ${res.status}: ${text}`);
		}

		const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const content = data.choices?.[0]?.message?.content ?? "";
		return sanitizeModelResponse(content.trim());
	},

	async chatWithTools(
		messages: Message[],
		toolsDef: ToolDef[],
		executeTool: ExecuteToolFn,
	): Promise<string> {
		const { baseUrl, apiKey, model } = getOpenRouterSettings();
		const MAX_TOOL_ITERATIONS = 10;

		type OpenRouterMessage = {
			role: "system" | "user" | "assistant" | "tool";
			content: string;
			tool_call_id?: string;
			tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
		};

		let currentMessages: OpenRouterMessage[] = messages.map(m => ({
			role: m.role,
			content: messageToContent(m),
		}));

		for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
					"HTTP-Referer": "https://shiro.ai",
					"X-Title": "Shiro",
				},
				body: JSON.stringify({
					model,
					messages: currentMessages,
					tools: toolsDef,
					tool_choice: "auto",
				}),
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`OpenRouter ${res.status}: ${text}`);
			}

			const data = (await res.json()) as {
				choices?: { message?: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
			};
			
			const msg = data.choices?.[0]?.message;
			if (!msg) break;

			const content = msg.content ?? "";
			const toolCalls = msg.tool_calls;

			if (!toolCalls?.length) {
				return sanitizeModelResponse(content.trim() || "(Sin respuesta)");
			}

			// Agregar mensaje del assistant con tool_calls
			currentMessages.push({
				role: "assistant",
				content: content || "Usando herramienta...",
				tool_calls: toolCalls.map(tc => ({
					id: tc.id,
					type: "function",
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				})),
			});

			for (const tc of toolCalls) {
				let args = {};
				try {
					args = JSON.parse(tc.function.arguments || "{}");
				} catch {
					args = {};
				}
				
				const result = await executeTool(tc.function.name, args);
				const resultContent = result.ok ? result.content : "Error: " + (result.error ?? "unknown");
				
				currentMessages.push({
					role: "tool",
					content: resultContent,
					tool_call_id: tc.id,
				});
			}
		}

		return "No pude responder en el límite de herramientas.";
	},

	getConfig(): { baseUrl: string; model: string; apiKey: string } {
		const { baseUrl, apiKey, model } = getOpenRouterSettings();
		return { baseUrl, model, apiKey: apiKey ? "***" + apiKey.slice(-4) : "" };
	},
};
