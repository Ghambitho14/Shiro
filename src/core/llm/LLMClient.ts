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
) => { ok: boolean; content: string; error?: string };

export interface LLMClient {
	/** Chat sin tools. Devuelve contenido de texto o lanza. */
	chat(messages: Message[]): Promise<string>;

	/** Chat con tools: ejecuta tool_calls en bucle hasta respuesta final o límite. */
	chatWithTools(
		messages: Message[],
		toolsDef: ToolDef[],
		executeTool: ExecuteToolFn,
	): Promise<string>;

	getConfig(): { baseUrl: string; model: string };
}
