import type { Message } from "../agent/Types.js";

export type ToolDef = {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	};
};

export type ExecuteToolFn = (
	name: string,
	args: Record<string, unknown>,
) => Promise<{ ok: boolean; content: string; error?: string }>;

export type ChatOptions = {
	/** Recibe el texto visible a medida que el modelo lo genera. */
	onDelta?: (chunk: string) => void;
	signal?: AbortSignal;
};

export interface LLMClient {
	/** Chat sin tools. Devuelve contenido de texto o lanza LLMError. */
	chat(messages: Message[], opts?: ChatOptions): Promise<string>;

	/** Chat con tools: ejecuta tool_calls en bucle hasta respuesta final o límite. */
	chatWithTools(
		messages: Message[],
		toolsDef: ToolDef[],
		executeTool: ExecuteToolFn,
		opts?: ChatOptions,
	): Promise<string>;

	/** Datos para mostrar (nunca incluye la API key completa). */
	getConfig(): { provider: string; baseUrl: string; model: string; local: boolean };
}

export type LLMErrorKind = "connection" | "timeout" | "auth" | "model_not_found" | "tools_unsupported" | "rate_limit" | "server" | "bad_request";

/** Error del modelo con un mensaje entendible para el usuario. */
export class LLMError extends Error {
	constructor(
		message: string,
		readonly kind: LLMErrorKind,
		readonly status?: number,
	) {
		super(message);
		this.name = "LLMError";
	}

	get retryable(): boolean {
		return this.kind === "connection" || this.kind === "rate_limit" || this.kind === "server" || this.kind === "timeout";
	}
}
