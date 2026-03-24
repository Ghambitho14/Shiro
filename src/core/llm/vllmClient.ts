import type { LLMClient, ToolDef } from "./LLMClient.js";
import type { Message, ContentPart } from "../agent/Types.js";
import { getConfig } from "../../config/config.js";
import { sanitizeModelResponse } from "../sanitizeResponse.js";
import { getMaxToolIterations, normalizeToolResult } from "./toolRuntime.js";

/** Ordena partes multimodales: imagen primero, luego texto (mejor para modelos de visión). */
function normalizeContentParts(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	const parts = content as ContentPart[];
	const imageParts = parts.filter((p) => p.type === "image_url");
	const textParts = parts.filter((p) => p.type === "text");
	if (imageParts.length === 0 || textParts.length === 0) return content;
	return [...imageParts, ...textParts];
}

function normalizeOpenAiBaseUrl(rawBaseUrl: string): string {
	const trimmed = rawBaseUrl.replace(/\/+$/, "");
	if (/\/v\d+$/i.test(trimmed)) return trimmed;
	return `${trimmed}/v1`;
}

function getVllmSettings(): { baseUrl: string; model: string; apiKey: string | undefined } {
	const cfg = getConfig();
	const rawBaseUrl = process.env.VLLM_BASE_URL ?? cfg.vllmBaseUrl ?? "http://127.0.0.1:8000/v1";
	return {
		baseUrl: normalizeOpenAiBaseUrl(rawBaseUrl),
		model: process.env.VLLM_MODEL ?? cfg.model ?? "default",
		apiKey: process.env.VLLM_API_KEY?.trim() ?? cfg.vllmApiKey?.trim(),
	};
}

type VllmMessage = Record<string, unknown>;

function buildRequestBody(params: { messages: VllmMessage[]; tools?: unknown[] }): Record<string, unknown> {
	const messages = params.messages.map((m) => {
		const content = (m as { content?: unknown }).content;
		const normalized = normalizeContentParts(content);
		if (normalized === content) return m;
		return { ...m, content: normalized };
	});
	const body: Record<string, unknown> = {
		model: getVllmSettings().model,
		messages,
		stream: false,
		max_tokens: 1024,
		temperature: 0.7,
	};
	if (params.tools?.length) {
		body.tools = params.tools;
		body.tool_choice = "auto";
	}
	return body;
}

export const vllmClient: LLMClient = {
	async chat(messages: Message[]): Promise<string> {
		const { baseUrl, apiKey } = getVllmSettings();
		const url = `${baseUrl}/chat/completions`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(buildRequestBody({ messages: messages as VllmMessage[] })),
		});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`vLLM ${res.status}: ${text || res.statusText}`);
		}

		const data = (await res.json()) as {
			choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
		};
		const choice = data.choices?.[0];
		const msg = choice?.message;
		const raw = (msg?.content ?? "").trim();
		const toolCalls = msg?.tool_calls;
		// Si hay texto, devolverlo (sin bloques <think>)
		if (raw) return sanitizeModelResponse(raw);
		if (Array.isArray(toolCalls) && toolCalls.length > 0) return "";
		return "";
	},

	async chatWithTools(
		messages: Message[],
		toolsDef: ToolDef[],
		executeTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: string; error?: string }>,
	): Promise<string> {
		const { baseUrl, apiKey } = getVllmSettings();
		const url = `${baseUrl}/chat/completions`;
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

		let currentMessages: VllmMessage[] = messages.map((m) => ({ ...m })) as VllmMessage[];
		let iterations = 0;
		const maxToolIterations = getMaxToolIterations();

		while (iterations < maxToolIterations) {
			iterations++;
			const body = buildRequestBody({ messages: currentMessages, tools: toolsDef });
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`vLLM ${res.status}: ${text || res.statusText}`);
			}

			const data = (await res.json()) as {
				choices?: Array<{
					message?: {
						content?: string | null;
						tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
					};
				}>;
			};
			const choice = data.choices?.[0];
			const msg = choice?.message;
			if (!msg) break;

			const content = msg.content ?? "";
			const toolCalls = msg.tool_calls;

			currentMessages.push(msg as VllmMessage);

			if (!toolCalls?.length) {
				return sanitizeModelResponse(content.trim() || "(Sin respuesta de texto)");
			}

			const toolResults = await Promise.all(toolCalls.map(async (tc) => {
				let args: Record<string, unknown> = {};
				try {
					args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
				} catch {
					args = {};
				}
				const result = await executeTool(tc.function.name, args);
				const resultContent = result.ok
					? normalizeToolResult(result.content)
					: normalizeToolResult("Error: " + (result.error ?? "unknown"));
				return {
					tool_call_id: tc.id,
					content: resultContent,
				};
			}));
			for (const toolResult of toolResults) {
				currentMessages.push({
					role: "tool",
					tool_call_id: toolResult.tool_call_id,
					content: toolResult.content,
				});
			}
		}

		return "No pude responder en esta vuelta (el modelo usó muchas herramientas seguidas). Prueba de nuevo o con una pregunta más concreta.";
	},

	getConfig(): { baseUrl: string; model: string } {
		const { baseUrl, model } = getVllmSettings();
		return { baseUrl, model };
	},
};
