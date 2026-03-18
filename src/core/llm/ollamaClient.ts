import type { LLMClient, ToolDef } from "./LLMClient.js";
import type { Message, ContentPart } from "../agent/Types.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { getConfig } from "../../config/config.js";

function getOllamaSettings(): { baseUrl: string; model: string } {
	const cfg = getConfig();
	const baseUrl = cfg.ollamaBaseUrl ?? "http://localhost:11434";
	const model = cfg.ollamaModel ?? "llama3.2";
	return { baseUrl, model };
}

function normalizeContentParts(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	const parts = content as ContentPart[];
	const imageParts = parts.filter((p) => p.type === "image_url");
	const textParts = parts.filter((p) => p.type === "text");
	if (imageParts.length === 0 || textParts.length === 0) return content;
	return [...imageParts, ...textParts];
}

function buildOllamaMessages(messages: Message[]): Record<string, unknown>[] {
	return messages.map((m) => {
		const content = normalizeContentParts(m.content);
		if (typeof content === "string") {
			return { role: m.role, content };
		}
		if (Array.isArray(content)) {
			const text = content.find((p) => p.type === "text")?.text ?? "";
			const images = content.filter((p) => p.type === "image_url");
			if (images.length > 0) {
				return {
					role: m.role,
					content: text,
					images: images.map((img: { image_url: { url: string } }) => {
						const url = img.image_url.url;
						if (url.startsWith("data:")) {
							const match = url.match(/base64,(.+)$/);
							return match ? match[1] : url;
						}
						return url;
					}),
				};
			}
			return { role: m.role, content: text };
		}
		return { role: m.role, content: String(content) };
	});
}

const MAX_TOOL_ITERATIONS = 10;

export const ollamaClient: LLMClient = {
	async chat(messages: Message[]): Promise<string> {
		const { baseUrl, model } = getOllamaSettings();
		const url = `${baseUrl}/api/chat`;

		const body = {
			model,
			messages: buildOllamaMessages(messages),
			stream: false,
		};

		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Ollama ${res.status}: ${text || res.statusText}`);
		}

		const data = (await res.json()) as { message?: { content?: string } };
		const content = data.message?.content ?? "";
		return sanitizeModelResponse(content.trim());
	},

	async chatWithTools(
		messages: Message[],
		toolsDef: ToolDef[],
		executeTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: string; error?: string }>,
	): Promise<string> {
		const { baseUrl, model } = getOllamaSettings();
		const url = `${baseUrl}/api/chat`;

		let currentMessages = buildOllamaMessages(messages);
		let iterations = 0;

		while (iterations < MAX_TOOL_ITERATIONS) {
			iterations++;

			const ollamaTools = toolsDef.map((t) => ({
				type: "function",
				function: {
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters,
				},
			}));

			const body = {
				model,
				messages: currentMessages,
				tools: ollamaTools,
				stream: false,
			};

			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text();
				throw new Error(`Ollama ${res.status}: ${text || res.statusText}`);
			}

			const data = (await res.json()) as {
				message?: {
					content?: string;
					tool_calls?: Array<{ function: { name: string; arguments: string } }>;
				};
			};
			const msg = data.message;
			if (!msg) break;

			const content = msg.content ?? "";
			const toolCalls = msg.tool_calls;

			currentMessages.push({
				role: "assistant",
				content,
				...(toolCalls && { tool_calls: toolCalls }),
			} as Record<string, unknown>);

			if (!toolCalls?.length) {
				return sanitizeModelResponse(content.trim() || "(Sin respuesta de texto)");
			}

			for (const tc of toolCalls) {
				let args: Record<string, unknown> = {};
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
				});
			}
		}

		return "No pude responder en esta vuelta (el modelo usó muchas herramientas seguidas). Prueba de nuevo o con una pregunta más concreta.";
	},

	getConfig(): { baseUrl: string; model: string } {
		const { baseUrl, model } = getOllamaSettings();
		return { baseUrl, model };
	},
};
