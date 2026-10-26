/** Tipos compartidos del agente: mensajes, eventos, pasos, resultados de tools. */

/** Parte de contenido multimodal (OpenAI-compatible). */
export type ContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

/** Contenido de un mensaje de usuario: solo texto o texto + imagen(es). */
export type UserContent = string | ContentPart[];

export type Message =
	| { role: "system"; content: string }
	| { role: "user"; content: UserContent }
	| ({ role: "assistant"; content: string | null; tool_calls?: ToolCallSpec[] } & AssistantCarry)
	| { role: "tool"; tool_call_id: string; name?: string; content: string };

/**
 * Lo que algunos modelos exigen que se les devuelva tal cual mientras usan herramientas
 * (su razonamiento). Solo vive dentro de una respuesta: no se guarda en el historial.
 */
export type AssistantCarry = {
	/** /chat/completions de modelos que razonan (DeepSeek, Kimi, GLM…). */
	reasoning_content?: string;
	/** Bloques originales del formato Anthropic (razonamiento firmado + uso de herramientas). */
	anthropic_blocks?: unknown[];
};

export type ToolCallSpec = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

export type EventType = "plan" | "step_status" | "tool_call" | "observation" | "error" | "summary" | "decision";

export type AgentEvent = {
	type: EventType;
	timestamp: string;
	runId: string;
	stepId?: string;
	payload: Record<string, unknown>;
};

/** `image`: ruta en disco de una imagen producida por la tool (captura de pantalla…). */
export type ToolResult = { ok: true; content: string; image?: string } | { ok: false; error: string };

export type LongTermSummary = {
	summary: string;
	keyFacts: string[];
	openTasks: string[];
};
