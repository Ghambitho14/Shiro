import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Message {
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	timestamp: string;
	toolCalls?: ToolCall[];
	toolResult?: string;
}

export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	result?: string;
	duration?: number;
}

export interface SessionTranscript {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messages: Message[];
	metadata: {
		model?: string;
		totalTokens?: number;
		toolCallsCount: number;
	};
}

/** Gestor de transcripciones de sesión */
export class SessionTranscripts {
	private sessionsDir: string;
	private sessions: Map<string, SessionTranscript> = new Map();

	constructor(sessionsDir: string = "./data/sessions") {
		this.sessionsDir = sessionsDir;
		this.ensureDir();
		this.loadAll();
	}

	private ensureDir(): void {
		if (!existsSync(this.sessionsDir)) {
			mkdirSync(this.sessionsDir, { recursive: true });
		}
	}

	private loadAll(): void {
		// Por ahora carga simple - en producción sería lazy
	}

	/** Crea una nueva sesión */
	create(name?: string): SessionTranscript {
		const id = `session_${Date.now()}`;
		const transcript: SessionTranscript = {
			id,
			name: name ?? id,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			messages: [],
			metadata: {
				toolCallsCount: 0,
			},
		};

		this.sessions.set(id, transcript);
		this.save(transcript);
		return transcript;
	}

	/** Obtiene una sesión por ID */
	get(id: string): SessionTranscript | null {
		if (this.sessions.has(id)) {
			return this.sessions.get(id)!;
		}

		// Intentar cargar desde disco
		const path = join(this.sessionsDir, `${id}.json`);
		if (existsSync(path)) {
			try {
				const data = JSON.parse(readFileSync(path, "utf-8")) as SessionTranscript;
				this.sessions.set(id, data);
				return data;
			} catch {
				return null;
			}
		}

		return null;
	}

	/** Agrega un mensaje a la sesión */
	addMessage(
		sessionId: string, 
		role: Message["role"], 
		content: string,
		toolCalls?: ToolCall[]
	): void {
		let session = this.get(sessionId);
		if (!session) {
			session = this.create(sessionId);
		}

		const message: Message = {
			role,
			content,
			timestamp: new Date().toISOString(),
			toolCalls,
		};

		session.messages.push(message);
		session.updatedAt = new Date().toISOString();

		if (toolCalls) {
			session.metadata.toolCallsCount += toolCalls.length;
		}

		this.sessions.set(sessionId, session);
		this.save(session);
	}

	/** Agrega resultado de tool */
	addToolResult(sessionId: string, toolName: string, result: string, duration?: number): void {
		const session = this.get(sessionId);
		if (!session) return;

		const lastMessage = session.messages[session.messages.length - 1];
		if (lastMessage && lastMessage.toolCalls) {
			const toolCall = lastMessage.toolCalls.find(tc => tc.name === toolName);
			if (toolCall) {
				toolCall.result = result;
				toolCall.duration = duration;
			}
		}

		session.updatedAt = new Date().toISOString();
		this.sessions.set(sessionId, session);
		this.save(session);
	}

	/** Lista todas las sesiones */
	list(): SessionTranscript[] {
		return Array.from(this.sessions.values()).sort(
			(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
		);
	}

	/** Obtiene historial de una sesión */
	getHistory(sessionId: string, limit?: number): Message[] {
		const session = this.get(sessionId);
		if (!session) return [];

		const messages = session.messages;
		return limit ? messages.slice(-limit) : messages;
	}

	/** Obtiene todas las tool calls de una sesión */
	getToolCalls(sessionId: string): ToolCall[] {
		const session = this.get(sessionId);
		if (!session) return [];

		const toolCalls: ToolCall[] = [];
		for (const msg of session.messages) {
			if (msg.toolCalls) {
				toolCalls.push(...msg.toolCalls);
			}
		}
		return toolCalls;
	}

	/** Obtiene estadísticas de la sesión */
	getStats(sessionId: string): {
		totalMessages: number;
		userMessages: number;
		assistantMessages: number;
		toolCalls: number;
		avgMessageLength: number;
		duration?: number;
	} | null {
		const session = this.get(sessionId);
		if (!session) return null;

		const userMessages = session.messages.filter(m => m.role === "user").length;
		const assistantMessages = session.messages.filter(m => m.role === "assistant").length;
		const totalLength = session.messages.reduce((sum, m) => sum + m.content.length, 0);

		const start = new Date(session.createdAt).getTime();
		const end = new Date(session.updatedAt).getTime();
		const duration = end - start;

		return {
			totalMessages: session.messages.length,
			userMessages,
			assistantMessages,
			toolCalls: session.metadata.toolCallsCount,
			avgMessageLength: session.messages.length > 0 
				? Math.round(totalLength / session.messages.length) 
				: 0,
			duration,
		};
	}

	/** Elimina una sesión */
	delete(sessionId: string): boolean {
		const session = this.get(sessionId);
		if (!session) return false;

		this.sessions.delete(sessionId);
		
		const path = join(this.sessionsDir, `${sessionId}.json`);
		if (existsSync(path)) {
			import("node:fs").then(fs => fs.unlinkSync(path));
		}

		return true;
	}

	/** Guarda sesión a disco */
	private save(session: SessionTranscript): void {
		const path = join(this.sessionsDir, `${session.id}.json`);
		writeFileSync(path, JSON.stringify(session, null, 2), "utf-8");
	}

	/** Exporta sesión a texto */
	exportToText(sessionId: string): string {
		const session = this.get(sessionId);
		if (!session) return "";

		let text = `# Sesión: ${session.name}\n`;
		text += `Creada: ${session.createdAt}\n`;
		text += `Actualizada: ${session.updatedAt}\n\n`;

		for (const msg of session.messages) {
			const role = msg.role.toUpperCase();
			const time = new Date(msg.timestamp).toLocaleTimeString();
			text += `\n[${time}] ${role}: ${msg.content}`;

			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					text += `\n  🔧 Tool: ${tc.name}(${JSON.stringify(tc.args)})`;
					if (tc.result) {
						text += `\n     Result: ${tc.result.slice(0, 100)}...`;
					}
				}
			}
		}

		return text;
	}
}
