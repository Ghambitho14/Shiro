import type { LLMClient, ToolDef, ExecuteToolFn } from "./LLMClient.js";
import type { Message } from "../agent/Types.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { getConfig } from "../../config/config.js";
import { getMaxToolIterations, normalizeToolResult } from "./toolRuntime.js";

function getOpenCodeSettings(): { baseUrl: string; apiKey: string; model: string } {
	const config = getConfig();
	const baseUrl =
		process.env.OPENCODE_BASE_URL?.trim() ||
		config.opencodeBaseUrl ||
		"https://api.opencode.ai/v1";
	const apiKey = process.env.OPENCODE_API_KEY?.trim() || config.opencodeApiKey?.trim() || "";
	const model =
		process.env.OPENCODE_MODEL?.trim() ||
		config.opencodeModel ||
		"kimi-k2.6";
	return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

function messageToContent(msg: Message): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join("");
	}
	return "";
}

function messageToOpenCode(msg: Message): Record<string, unknown> {
	if (msg.role === "tool") {
		return { role: msg.role, content: msg.content, tool_call_id: msg.tool_call_id };
	}
	const content = msg.content;
	if (Array.isArray(content)) {
		return {
			role: msg.role,
			content: content.map((part) => {
				if (part.type === "text") return { type: "text", text: part.text };
				return { type: "image_url", image_url: { url: part.image_url.url } };
			}),
		};
	}
	if (msg.role === "assistant") {
		return { role: msg.role, content: content ?? "" };
	}
	return { role: msg.role, content: messageToContent(msg) };
}

export const opencodeClient: LLMClient = {
	async chat(messages: Message[]): Promise<string> {
		const { baseUrl, apiKey, model } = getOpenCodeSettings();

		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: messages.map((m) => ({
					role: m.role,
					content: messageToContent(m),
				})),
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`OpenCode ${res.status}: ${text}`);
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
		const { baseUrl, apiKey, model } = getOpenCodeSettings();
		const maxToolIterations = getMaxToolIterations();

		type OpenCodeMessage = {
			role: "system" | "user" | "assistant" | "tool";
			content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
			tool_call_id?: string;
			tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
		};

		let currentMessages: OpenCodeMessage[] = messages.map((m) => messageToOpenCode(m) as OpenCodeMessage);

		for (let i = 0; i < maxToolIterations; i++) {
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
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
				throw new Error(`OpenCode ${res.status}: ${text}`);
			}

			const data = (await res.json()) as {
				choices?: {
					message?: {
						content?: string;
						tool_calls?: { id: string; function: { name: string; arguments: string } }[];
					};
				}[];
			};

			const msg = data.choices?.[0]?.message;
			if (!msg) break;

			const content = msg.content ?? "";
			const toolCalls = msg.tool_calls;

			if (!toolCalls?.length) {
				return sanitizeModelResponse(content.trim() || "(Sin respuesta)");
			}

			currentMessages.push({
				role: "assistant",
				content: content || "Usando herramienta...",
				tool_calls: toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: {
						name: tc.function.name,
						arguments: tc.function.arguments,
					},
				})),
			});

			const toolResults = await Promise.all(
				toolCalls.map(async (tc) => {
					let args = {};
					try {
						args = JSON.parse(tc.function.arguments || "{}");
					} catch {
						args = {};
					}
					const result = await executeTool(tc.function.name, args);
					const resultContent = result.ok
						? normalizeToolResult(result.content)
						: normalizeToolResult("Error: " + (result.error ?? "unknown"));
					return { id: tc.id, resultContent };
				}),
			);

			for (const toolResult of toolResults) {
				currentMessages.push({
					role: "tool",
					content: toolResult.resultContent,
					tool_call_id: toolResult.id,
				});
			}
		}

		return "No pude responder en el límite de herramientas.";
	},

	getConfig(): { baseUrl: string; model: string; apiKey: string } {
		const { baseUrl, apiKey, model } = getOpenCodeSettings();
		return { baseUrl, model, apiKey: apiKey ? "***" + apiKey.slice(-4) : "" };
	},
};
