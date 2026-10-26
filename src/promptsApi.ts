/**
 * API de Ajustes → Personalización → "Instrucciones de Shiro": las partes del system prompt que el
 * usuario puede reescribir. Cada una trae su texto por defecto y se puede volver a él.
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getConfig, setConfig } from "./config/config.js";
import { WORKSPACE_MAX_CHARS } from "./core/agent/ContextBuilder.js";
import { DEFAULT_SYSTEM_PROMPT } from "./core/soul/soul.js";
import { EDITABLE_NOTES, readNote, writeNote, type EditableNote } from "./workspace.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

const MAX_CHARS = 20000;

/** Textos que se muestran en la web, en el orden en que van en el system prompt. */
const PROMPTS = [
	{
		id: "system",
		title: "Instrucciones base",
		description:
			"El comienzo de todo lo que lee antes de responder: quién es, cómo usa las herramientas y sus reglas. Puedes usar {{nombre}}, {{usuario}}, {{carpeta}} y {{fecha}}: se cambian por su nombre, el tuyo, tu carpeta personal y la fecha de hoy.",
	},
	{ id: "soul", title: "Personalidad (SOUL.md)", description: "Su forma de ser: carácter, tono, límites y lo que valora." },
	{
		id: "memory",
		title: "Memoria a largo plazo (MEMORY.md)",
		description: "Lo que debe recordar siempre de ti y de tus cosas. También lo escribe él cuando aprende algo importante.",
	},
	{ id: "tools", title: "Guía de herramientas (TOOLS.md)", description: "Consejos sobre qué herramienta usar en cada caso." },
] as const;

type PromptId = (typeof PROMPTS)[number]["id"];

const isNote = (id: PromptId): id is EditableNote => id in EDITABLE_NOTES;

function item(id: PromptId) {
	const meta = PROMPTS.find((p) => p.id === id)!;
	const defaultValue = isNote(id) ? EDITABLE_NOTES[id].template : DEFAULT_SYSTEM_PROMPT;
	const value = isNote(id) ? readNote(id) : getConfig().systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
	return { ...meta, value, defaultValue, custom: value.trim() !== defaultValue.trim() };
}

function save(id: PromptId, value: string | undefined): void {
	if (isNote(id)) {
		writeNote(id, value);
		return;
	}
	// Igual que el de por defecto (o vacío): no se guarda, así le llegan las mejoras de futuras versiones.
	const clean = value?.trim();
	setConfig({ systemPrompt: clean && clean !== DEFAULT_SYSTEM_PROMPT.trim() ? clean : undefined });
}

export async function handlePromptsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, { readJson, sendJson }: Helpers): Promise<boolean> {
	if (!pathname.startsWith("/api/prompts")) return false;
	if (pathname === "/api/prompts" && method === "GET") {
		sendJson(res, 200, { items: PROMPTS.map((p) => item(p.id)), workspaceMaxChars: WORKSPACE_MAX_CHARS });
		return true;
	}
	const id = pathname.slice("/api/prompts/".length) as PromptId;
	if (!PROMPTS.some((p) => p.id === id)) {
		sendJson(res, 404, { error: "No existe ese texto." });
		return true;
	}
	try {
		if (method === "PUT") {
			const d = await readJson<{ value?: unknown }>(req);
			if (typeof d.value !== "string") throw new Error("Falta el texto.");
			if (d.value.length > MAX_CHARS) throw new Error(`Es demasiado largo (máx. ${MAX_CHARS.toLocaleString("es")} caracteres).`);
			save(id, d.value);
		} else if (method === "DELETE") {
			save(id, undefined);
		} else {
			sendJson(res, 405, { error: "Método no permitido" });
			return true;
		}
		sendJson(res, 200, { item: item(id) });
	} catch (err) {
		sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
	}
	return true;
}
