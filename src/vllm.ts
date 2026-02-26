import { getConfig } from "./config.js";

function getVllmSettings(): { baseUrl: string; model: string; apiKey: string | undefined } {
	const cfg = getConfig();
	return {
		baseUrl: (process.env.VLLM_BASE_URL ?? cfg.vllmBaseUrl ?? "http://127.0.0.1:8000/v1").replace(/\/+$/, ""),
		model: process.env.VLLM_MODEL ?? cfg.model ?? "default",
		apiKey: process.env.VLLM_API_KEY?.trim() ?? cfg.vllmApiKey?.trim(),
	};
}

export type ChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
	| { role: "tool"; tool_call_id: string; content: string };

type VllmMessage = Record<string, unknown>;

function buildRequestBody(params: { messages: VllmMessage[]; tools?: unknown[] }): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: getVllmSettings().model,
		messages: params.messages,
		stream: false,
		max_tokens: 4096,
	};
	if (params.tools?.length) {
		body.tools = params.tools;
		body.tool_choice = "auto";
	}
	return body;
}

export async function chat(messages: ChatMessage[]): Promise<string> {
	const { baseUrl, model, apiKey } = getVllmSettings();
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
		choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
	};
	const choice = data.choices?.[0];
	const msg = choice?.message;
	const content = msg?.content ?? "";
	const toolCalls = msg?.tool_calls;
	if (toolCalls?.length) {
		return ""; // caller should use chatWithTools
	}
	return content;
}

const MAX_TOOL_ITERATIONS = 10;

/**
 * Chat con herramientas: si el modelo devuelve tool_calls, se ejecutan y se reenvía el resultado (bucle).
 * Requiere que vLLM tenga soporte para tools (--enable-auto-tool-choice). Si no, se comporta como chat() sin tools.
 */
export async function chatWithTools(
	messages: ChatMessage[],
	toolsDef: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>,
	executeTool: (name: string, args: Record<string, unknown>) => { ok: boolean; content: string; error?: string },
): Promise<string> {
	const { baseUrl, apiKey } = getVllmSettings();
	const url = `${baseUrl}/chat/completions`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	let currentMessages: VllmMessage[] = messages.map((m) => ({ ...m })) as VllmMessage[];
	let iterations = 0;

	while (iterations < MAX_TOOL_ITERATIONS) {
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
			return content.trim() || "(Sin respuesta de texto)";
		}

		for (const tc of toolCalls) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
			} catch {
				args = {};
			}
			const result = executeTool(tc.function.name, args);
			const resultContent = result.ok ? result.content : ("Error: " + (result.error ?? "unknown"));
			currentMessages.push({
				role: "tool",
				tool_call_id: tc.id,
				content: resultContent,
			});
		}
	}

	return "(Límite de iteraciones de herramientas alcanzado)";
}

export function getVllmConfig(): { baseUrl: string; model: string } {
	const { baseUrl, model } = getVllmSettings();
	return { baseUrl, model };
}
