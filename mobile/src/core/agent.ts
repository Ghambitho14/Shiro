/**
 * Una respuesta del asistente en el móvil: el modelo de Ollama Cloud con cuatro herramientas
 * (memoria compartida y web). Los nombres son los mismos que en el PC, así las instrucciones
 * y SOUL.md sirven igual.
 */
import { chatTurn, webFetch, webSearch, type OllamaConn, type OllamaMessage, type ToolSpec } from "./ollama";
import { base64Of, splitContent } from "./content";
import { completeReminder, createReminder, isPending, listReminders, REPEAT_LABELS } from "./reminders";
import { addMemory, searchMemories, type SupabaseConn } from "./supabase";
import { messageText } from "./text";
import type { ChatMessage, ToolUse } from "./types";

export const MOBILE_TOOLS: ToolSpec[] = [
	{
		type: "function",
		function: {
			name: "memory_search",
			description: "Busca en la memoria a largo plazo del usuario (lo que guardaste antes, aquí o en el PC).",
			parameters: {
				type: "object",
				properties: { query: { type: "string", description: "Qué buscar" }, limit: { type: "number", description: "Máximo de resultados (5)" } },
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "memory_add",
			description: "Guarda un dato del usuario que valga la pena recordar. important=true lo apunta también en MEMORY.md (lo tendrás siempre presente).",
			parameters: {
				type: "object",
				properties: {
					content: { type: "string", description: "El dato, en una frase" },
					type: { type: "string", enum: ["fact", "preference", "decision", "observation", "event"] },
					tags: { type: "array", items: { type: "string" } },
					important: { type: "boolean" },
				},
				required: ["content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_web",
			description: "Busca en internet. Úsala para noticias, deportes, precios, clima y todo lo que cambia.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" }, max_results: { type: "number", description: "1 a 10 (5)" } },
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "create_reminder",
			description: "Crea un recordatorio (el teléfono y el PC avisan cuando toca).",
			parameters: {
				type: "object",
				properties: {
					title: { type: "string", description: "Qué recordar" },
					datetime: { type: "string", description: "Fecha y hora en ISO con la hora local (2026-10-27T18:00) o relativa: «en 30 minutos»" },
					repeat: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
					description: { type: "string" },
				},
				required: ["title", "datetime"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_reminders",
			description: "Lista los recordatorios pendientes (con include_completed, también los hechos).",
			parameters: { type: "object", properties: { include_completed: { type: "boolean" } } },
		},
	},
	{
		type: "function",
		function: {
			name: "complete_reminder",
			description: "Marca un recordatorio como hecho (usa el id de list_reminders).",
			parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		},
	},
	{
		type: "function",
		function: {
			name: "fetch_url",
			description: "Lee el texto de una página web (por ejemplo, un resultado de search_web).",
			parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
		},
	},
];

/** Lo que se ve en el chat mientras trabaja ("Buscando en internet…"). */
export function toolLabel(name: string, args: Record<string, unknown>): string {
	const q = typeof args.query === "string" ? `: ${args.query}` : "";
	switch (name) {
		case "memory_search":
			return `Buscando en tu memoria${q}`;
		case "memory_add":
			return "Guardando en tu memoria";
		case "search_web":
			return `Buscando en internet${q}`;
		case "create_reminder":
			return `Creando recordatorio${typeof args.title === "string" ? `: ${args.title}` : ""}`;
		case "list_reminders":
			return "Mirando tus recordatorios";
		case "complete_reminder":
			return "Marcando un recordatorio como hecho";
		case "fetch_url":
			return `Leyendo ${typeof args.url === "string" ? args.url.replace(/^https?:\/\//, "").slice(0, 60) : "una página"}`;
		default:
			return name;
	}
}

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "\n…(recortado)" : text);

export async function runTool(name: string, args: Record<string, unknown>, ctx: { sb: SupabaseConn; ollama: OllamaConn; signal?: AbortSignal }): Promise<string> {
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (name) {
		case "memory_search": {
			const hits = await searchMemories(ctx.sb, str(args.query), typeof args.limit === "number" ? args.limit : 5);
			return hits.length ? hits.map((h) => `- ${h.content} (${h.createdAt.slice(0, 10)})`).join("\n") : "No encontré nada sobre eso en la memoria.";
		}
		case "memory_add": {
			const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
			await addMemory(ctx.sb, { content: str(args.content), type: str(args.type) || undefined, tags, important: args.important === true });
			return args.important === true ? "Guardado (también en MEMORY.md)." : "Guardado.";
		}
		case "search_web": {
			const results = await webSearch(ctx.ollama, str(args.query), typeof args.max_results === "number" ? args.max_results : 5, ctx.signal);
			if (!results.length) return "La búsqueda no devolvió resultados.";
			return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${clip(r.content, 1200)}`).join("\n\n");
		}
		case "create_reminder": {
			const r = await createReminder(ctx.sb, { title: str(args.title), datetime: str(args.datetime), description: str(args.description), repeat: str(args.repeat) });
			const when = new Date(r.datetime).toLocaleString("es", { dateStyle: "full", timeStyle: "short" });
			return `Recordatorio creado: «${r.title}» para el ${when}${r.repeat && r.repeat !== "none" ? ` (${REPEAT_LABELS[r.repeat].toLowerCase()})` : ""}. ID: ${r.id}`;
		}
		case "list_reminders": {
			const all = await listReminders(ctx.sb);
			const list = args.include_completed === true ? all : all.filter(isPending);
			if (!list.length) return "No tienes recordatorios pendientes.";
			return list
				.map((r) => `- ${r.title} — ${new Date(r.datetime).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" })}${r.completed ? " (hecho)" : ""} [id: ${r.id}]`)
				.join("\n");
		}
		case "complete_reminder": {
			const r = await completeReminder(ctx.sb, str(args.id));
			return r ? `Hecho: «${r.title}».` : "No encontré ese recordatorio. Mira los ids con list_reminders.";
		}
		case "fetch_url": {
			const url = str(args.url);
			if (!/^https?:\/\//i.test(url)) return "La dirección tiene que empezar por http:// o https://.";
			const page = await webFetch(ctx.ollama, url, ctx.signal);
			return `${page.title}\n\n${clip(page.content, 8000)}`;
		}
		default:
			return `La herramienta ${name} no existe en el móvil.`;
	}
}

/**
 * El historial para el modelo: los últimos mensajes que caben. Las imágenes van solo en los tres
 * últimos mensajes del usuario (pesan mucho); los archivos de texto van dentro del texto.
 */
export function toOllamaHistory(messages: ChatMessage[], maxChars = 24_000): OllamaMessage[] {
	const out: OllamaMessage[] = [];
	let used = 0;
	let withImages = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		const text = messageText(m.content).trim();
		const images = m.role === "user" && withImages < 3 ? splitContent(m.content).images.map(base64Of) : [];
		if (!text && !images.length) continue;
		used += text.length;
		if (used > maxChars && out.length) break;
		if (m.role === "user") {
			if (images.length) withImages++;
			out.unshift(images.length ? { role: "user", content: text, images } : { role: "user", content: text });
		} else out.unshift({ role: "assistant", content: m.agentName ? `[${m.agentName}]: ${text}` : text });
	}
	return out;
}

export type TurnEvents = {
	onDelta?: (text: string) => void;
	onTool?: (label: string, done: boolean, ok?: boolean) => void;
};

/** Una respuesta completa: el modelo puede usar herramientas varias veces (como mucho `maxSteps`). */
export async function runAgentTurn(
	ctx: { sb: SupabaseConn; ollama: OllamaConn; model: string; system: string; signal?: AbortSignal; maxSteps?: number },
	history: ChatMessage[],
	events: TurnEvents = {},
): Promise<{ text: string; tools: ToolUse[] }> {
	const messages: OllamaMessage[] = [{ role: "system", content: ctx.system }, ...toOllamaHistory(history)];
	const tools: ToolUse[] = [];
	let text = "";
	const maxSteps = ctx.maxSteps ?? 8;
	for (let step = 0; step < maxSteps; step++) {
		const last = step === maxSteps - 1;
		const turn = await chatTurn(ctx.ollama, {
			model: ctx.model,
			messages,
			// En la última vuelta ya no se ofrecen herramientas: tiene que contestar.
			tools: last ? undefined : MOBILE_TOOLS,
			onDelta: (piece) => {
				text += piece;
				events.onDelta?.(piece);
			},
			signal: ctx.signal,
		});
		if (!turn.toolCalls.length) return { text: text.trim(), tools };
		messages.push({ role: "assistant", content: turn.content, tool_calls: turn.toolCalls });
		for (const call of turn.toolCalls) {
			const label = toolLabel(call.function.name, call.function.arguments);
			events.onTool?.(label, false);
			let result: string;
			let ok = true;
			try {
				result = await runTool(call.function.name, call.function.arguments, ctx);
			} catch (err) {
				if (ctx.signal?.aborted) throw err;
				ok = false;
				result = `Error: ${err instanceof Error ? err.message : String(err)}`;
			}
			tools.push({ name: call.function.name, label, ok });
			events.onTool?.(label, true, ok);
			messages.push({ role: "tool", content: result, tool_name: call.function.name });
		}
		// Lo que escribió antes de usar herramientas se separa de lo que venga después.
		if (text && !text.endsWith("\n")) {
			text += "\n\n";
			events.onDelta?.("\n\n");
		}
	}
	return { text: text.trim(), tools };
}
