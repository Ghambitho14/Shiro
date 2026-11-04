import type { Message } from "../agent/Types.js";

export type ToolDef = {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	};
};

/** `image`: data URL de una imagen que el modelo debe ver (p. ej. una captura de pantalla). */
export type ExecuteToolFn = (
	name: string,
	args: Record<string, unknown>,
) => Promise<{ ok: boolean; content: string; error?: string; image?: string }>;

/** Tokens de una vuelta con el modelo: leídos, escritos y, de los escritos, pensando (si se sabe). */
export type TokenUsage = { input: number; output: number; reasoning?: number };

/** Lo que gastó una respuesta entera (todas sus vueltas con el modelo): lo que se guarda y se muestra. */
export type ResponseUsage = { input: number; output: number; reasoning: number; turns: number };

export const newUsage = (): ResponseUsage => ({ input: 0, output: 0, reasoning: 0, turns: 0 });

export function addUsage(total: ResponseUsage, u: TokenUsage): void {
	total.input += u.input;
	total.output += u.output;
	total.reasoning += u.reasoning ?? 0;
	total.turns++;
}

export type ChatOptions = {
	/** Recibe el texto visible a medida que el modelo lo genera. */
	onDelta?: (chunk: string) => void;
	/** Se llama tras cada vuelta con el modelo con los tokens que gastó (si el servidor lo dice). */
	onUsage?: (usage: TokenUsage) => void;
	signal?: AbortSignal;
	/** Id de la conversación (OpenCode Go lo exige para enrutar y cachear). */
	sessionId?: string;
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

export type LLMErrorKind =
	| "connection"
	| "timeout"
	| "auth"
	| "model_not_found"
	| "tools_unsupported"
	| "rate_limit"
	| "server"
	| "bad_request"
	/** El modelo no acepta la forma de pedirle cuánto pensar (transports.ts prueba otra). */
	| "reasoning_unsupported"
	| "cancelled";

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
