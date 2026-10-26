/**
 * Perfiles de agentes (data/agents.json): Viernes, Lunes… Cada uno con su nombre, su modelo,
 * su forma de ser, sus herramientas y su voz. Se juntan en salas (src/core/rooms/).
 *
 * Siempre se guarda en este equipo, como mcp.json, sea cual sea Ajustes → Datos.
 * El asistente de siempre no es un perfil: los chats sin sala no usan este archivo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR, LLM_PROVIDERS } from "../../config/config.js";
import { normalizeName, slugify } from "./text.js";

export const AGENTS_FILE = join(DATA_DIR, "agents.json");

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_GREETING = "Hola, soy {{nombre}}. ¿En qué te ayudo?";

/** Palabras que no pueden ser nombre de agente: chocarían con las órdenes de las salas. */
const RESERVED = new Set([
	"activa", "activar", "agrega", "agregar", "anade", "suma", "invita", "trae", "llama", "quita", "saca",
	"despide", "sala", "salas", "todos", "todas", "tu", "yo", "usuario", "gracias", "hola", "oye", "hey",
	"principal", "agente", "agentes", "nadie",
]);

const httpUrl = z
	.string()
	.trim()
	.transform((u) => u.replace(/\/+$/, ""))
	.refine((u) => {
		try {
			const p = new URL(u).protocol;
			return p === "http:" || p === "https:";
		} catch {
			return false;
		}
	});

const voiceSchema = z
	.object({
		/** Voz del navegador (voiceURI de speechSynthesis). */
		browserVoiceURI: z.string().trim().min(1).max(300).optional().catch(undefined),
		/** Voz del servidor de voz (Ajustes → Voz → servidor), p. ej. "nova". */
		serverVoice: z.string().trim().regex(/^[\w.-]{1,40}$/).optional().catch(undefined),
		rate: z.number().min(0.5).max(2).optional().catch(undefined),
	})
	.default({})
	.catch({});

const profileFields = {
	name: z.string().trim().min(1).max(40),
	aliases: z.array(z.string().trim().min(1).max(40)).max(10).default([]).catch([]),
	description: z.string().trim().max(300).default("").catch(""),
	/** Sin proveedor ni modelo: usa el de Ajustes → Modelo. */
	provider: z.enum(LLM_PROVIDERS).optional().catch(undefined),
	model: z.string().trim().min(1).max(200).optional().catch(undefined),
	/** Solo hace falta si el proveedor no es el de Ajustes y no está en su dirección de siempre. */
	baseUrl: httpUrl.optional().catch(undefined),
	/** Forma de ser: se añade a las instrucciones base ("add") o las reemplaza ("replace"). */
	persona: z.string().max(8000).default("").catch(""),
	personaMode: z.enum(["add", "replace"]).default("add").catch("add"),
	/** inherit: las mismas que el asistente · none: solo texto · lista: solo esas. */
	tools: z
		.union([z.literal("inherit"), z.literal("none"), z.array(z.string().trim().min(1).max(80)).max(100)])
		.default("inherit")
		.catch("inherit"),
	/** Ofrecer las herramientas de los conectores MCP. */
	mcp: z.boolean().default(true).catch(true),
	/** Cómo se abre al activarlo: chat de texto o modo voz. */
	mode: z.enum(["text", "voice"]).default("text").catch("text"),
	voice: voiceSchema,
	greeting: z.string().trim().max(200).default(DEFAULT_GREETING).catch(DEFAULT_GREETING),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().catch(undefined),
};

export const agentProfileSchema = z.object({ id: z.string().regex(AGENT_ID_RE), ...profileFields });
/** Lo que llega de Ajustes al crear o editar (el id lo pone Shiro). */
export const agentInputSchema = z.object(profileFields);

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentInput = z.input<typeof agentInputSchema>;

export type ValidationContext = {
	/** Nombre del asistente de siempre (no puede tenerlo un agente). */
	assistantName: string;
	wakeWord: string;
	/** Herramientas que existen; si se da, las demás se quitan con un aviso. */
	knownTools?: string[];
};

function issuesText(err: z.ZodError): string {
	const labels: Record<string, string> = { name: "nombre", id: "id" };
	return err.issues.map((i) => `${labels[String(i.path[0])] ?? i.path.join(".")}: ${i.message}`).join("; ");
}

/** Valida el contenido completo de agents.json. Lanza un Error legible si algo está mal. */
export function parseAgentsJson(text: string): AgentProfile[] {
	let data: unknown;
	try {
		data = text.trim() ? JSON.parse(text) : {};
	} catch (err) {
		throw new Error(`El JSON no es válido: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error('Debe ser un objeto: { "agents": [ ... ] }');
	const raw = (data as { agents?: unknown }).agents ?? [];
	if (!Array.isArray(raw)) throw new Error('"agents" debe ser una lista de agentes.');
	return raw.map((value, n) => {
		const parsed = agentProfileSchema.safeParse(value);
		if (!parsed.success) throw new Error(`Agente ${n + 1}: ${issuesText(parsed.error)}`);
		return parsed.data;
	});
}

export function loadAgents(): { agents: AgentProfile[]; error?: string } {
	if (!existsSync(AGENTS_FILE)) return { agents: [] };
	try {
		return { agents: parseAgentsJson(readFileSync(AGENTS_FILE, "utf-8")) };
	} catch (err) {
		return { agents: [], error: `data/agents.json tiene un error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function saveAgents(agents: AgentProfile[]): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(AGENTS_FILE, JSON.stringify({ version: 1, agents }, null, 2) + "\n", "utf-8");
}

export function getAgent(id: string): AgentProfile | undefined {
	return loadAgents().agents.find((a) => a.id === id);
}

/** Todos los nombres por los que se puede llamar a un agente (normalizados, sin repetir). */
export function agentNames(a: Pick<AgentProfile, "name" | "aliases">): string[] {
	return [...new Set([a.name, ...a.aliases].map(normalizeName).filter(Boolean))];
}

/**
 * Comprueba que los nombres no se confundan entre sí ni con las órdenes.
 * Devuelve errores (no se puede guardar) y avisos (se guarda igual).
 */
export function validateProfiles(agents: AgentProfile[], ctx: ValidationContext): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const owner = new Map<string, string>();
	const assistant = normalizeName(ctx.assistantName);
	const wake = normalizeName(ctx.wakeWord);
	for (const a of agents) {
		for (const n of agentNames(a)) {
			if (n.length < 3) errors.push(`«${n}» es muy corto: los nombres de agente necesitan al menos 3 letras.`);
			else if (n === assistant) errors.push(`«${a.name}» no puede llamarse igual que el asistente (${ctx.assistantName}).`);
			else if (n === wake) errors.push(`«${n}» es la palabra de activación: elige otro nombre para ${a.name}.`);
			else if (RESERVED.has(n)) errors.push(`«${n}» es una palabra de las órdenes de sala: elige otro nombre.`);
			const other = owner.get(n);
			if (other && other !== a.id) {
				const otherName = agents.find((x) => x.id === other)?.name ?? other;
				errors.push(`«${n}» ya lo usa ${otherName}: cada nombre o alias tiene que ser de un solo agente.`);
			}
			owner.set(n, a.id);
		}
		if (ctx.knownTools && Array.isArray(a.tools)) {
			const known = new Set(ctx.knownTools);
			const unknown = a.tools.filter((t) => !known.has(t));
			if (unknown.length) {
				a.tools = a.tools.filter((t) => known.has(t));
				warnings.push(`${a.name}: se quitaron herramientas que no existen (${unknown.join(", ")}).`);
			}
		}
		if (a.model && !a.provider) warnings.push(`${a.name}: el modelo «${a.model}» se usará con el proveedor de Ajustes → Modelo.`);
	}
	return { errors: [...new Set(errors)], warnings };
}

function uniqueId(name: string, taken: Set<string>): string {
	const base = slugify(name) || "agente";
	let id = base;
	for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 36)}-${n}`;
	return id;
}

function parseInput(input: unknown): z.infer<typeof agentInputSchema> {
	const parsed = agentInputSchema.safeParse(input);
	if (!parsed.success) throw new Error(`Datos del agente no válidos: ${issuesText(parsed.error)}`);
	return parsed.data;
}

function commit(agents: AgentProfile[], ctx: ValidationContext): string[] {
	const { errors, warnings } = validateProfiles(agents, ctx);
	if (errors.length) throw new Error(errors.join(" "));
	saveAgents(agents);
	return warnings;
}

function loadForEdit(): AgentProfile[] {
	const { agents, error } = loadAgents();
	if (error) throw new Error(`${error} Arréglalo o bórralo antes de editar los agentes.`);
	return agents;
}

export function createAgent(input: unknown, ctx: ValidationContext): { agent: AgentProfile; warnings: string[] } {
	const agents = loadForEdit();
	const fields = parseInput(input);
	const agent: AgentProfile = { id: uniqueId(fields.name, new Set(agents.map((a) => a.id))), ...fields };
	const warnings = commit([...agents, agent], ctx);
	return { agent, warnings };
}

export function updateAgent(id: string, input: unknown, ctx: ValidationContext): { agent: AgentProfile; warnings: string[] } {
	const agents = loadForEdit();
	const idx = agents.findIndex((a) => a.id === id);
	if (idx < 0) throw new Error("Ese agente ya no existe.");
	// El id no cambia al renombrar: las salas y los mensajes lo usan.
	const agent: AgentProfile = { id, ...parseInput(input) };
	const next = [...agents];
	next[idx] = agent;
	const warnings = commit(next, ctx);
	return { agent, warnings };
}

export function deleteAgent(id: string): boolean {
	const agents = loadForEdit();
	const next = agents.filter((a) => a.id !== id);
	if (next.length === agents.length) return false;
	saveAgents(next);
	return true;
}

/** El saludo del agente con su nombre puesto. */
export function renderGreeting(a: Pick<AgentProfile, "name" | "greeting">): string {
	return (a.greeting || DEFAULT_GREETING).replace(/\{\{\s*nombre\s*\}\}/gi, a.name);
}
