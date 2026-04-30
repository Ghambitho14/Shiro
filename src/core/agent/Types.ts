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
	| { role: "assistant"; content: string | null; tool_calls?: ToolCallSpec[] }
	| { role: "tool"; tool_call_id: string; content: string };

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

export type Step = {
	id: string;
	goal: string;
	status: "pending" | "running" | "done" | "failed";
	result?: string;
	error?: string;
};

export type ToolResult = { ok: true; content: string } | { ok: false; error: string };

export type LongTermSummary = {
	summary: string;
	keyFacts: string[];
	openTasks: string[];
};
