/** Mismo formato que los chats de Shiro en el PC (tabla shiro_chats): así se ven en los dos sitios. */
export type ToolUse = { name: string; label: string; ok: boolean };

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
	role: "user" | "assistant";
	content: string | ContentPart[];
	ts?: number;
	tools?: ToolUse[];
	agent?: string;
	agentName?: string;
};

export type ChatMeta = { id: string; title: string; createdAt: number; updatedAt: number; lastPreview: string };
export type Chat = ChatMeta & { messages: ChatMessage[] };

/** Lo que la app guarda en el teléfono (las claves, cifradas por el sistema). */
export type AppSettings = {
	supabaseUrl: string;
	supabaseKey: string;
	ollamaKey: string;
	model: string;
	/** Vacío = el nombre que tenga Shiro en el PC. */
	assistantName: string;
};

export const DEFAULT_SETTINGS: AppSettings = { supabaseUrl: "", supabaseKey: "", ollamaKey: "", model: "gpt-oss:120b", assistantName: "" };

export type FetchFn = typeof fetch;
