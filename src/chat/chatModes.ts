/**
 * En qué modo (Chat, Code, Hacking) está cada chat: cada modo tiene su propia lista en la web.
 * Se guarda aparte, en `data/chat-modes.json` de este equipo (como las salas), para no tocar
 * las tablas de ningún almacenamiento (local, Obsidian, Supabase). Un chat sin anotar es de Chat.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "../config/config.js";
import { CHAT_MODES, type ChatMode } from "../core/agent/chatMode.js";

const isMode = (v: unknown): v is ChatMode => typeof v === "string" && (CHAT_MODES as readonly string[]).includes(v);

function modesFile(): string {
	return join(DATA_DIR, "chat-modes.json");
}

let cache: Record<string, ChatMode> | null = null;

function load(): Record<string, ChatMode> {
	if (cache) return cache;
	const out: Record<string, ChatMode> = {};
	try {
		if (existsSync(modesFile())) {
			const raw = JSON.parse(readFileSync(modesFile(), "utf-8")) as Record<string, unknown>;
			for (const [id, mode] of Object.entries(raw ?? {})) if (isMode(mode)) out[id] = mode;
		}
	} catch {
		// Archivo dañado: se empieza de cero y los chats se vuelven a clasificar por sus mensajes.
	}
	cache = out;
	return out;
}

function save(map: Record<string, ChatMode>): void {
	const file = modesFile();
	mkdirSync(dirname(file), { recursive: true });
	// Primero a un archivo temporal: si se corta a medias, el de antes sigue entero.
	writeFileSync(file + ".tmp", JSON.stringify(map, null, 2) + "\n", "utf-8");
	renameSync(file + ".tmp", file);
}

/** El modo anotado de un chat, o undefined si aún no se sabe. */
export function getChatMode(id: string): ChatMode | undefined {
	return load()[id];
}

export function setChatMode(id: string, mode: ChatMode): void {
	const map = load();
	if (map[id] === mode) return;
	map[id] = mode;
	save(map);
}

export function removeChatMode(id: string): void {
	const map = load();
	if (!(id in map)) return;
	delete map[id];
	save(map);
}

/** El modo que dicen los mensajes: el del último mensaje del usuario que lo tenga (así se abrían los chats viejos). */
export function modeOfMessages(messages: { role: string; mode?: unknown }[]): ChatMode | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user" && isMode(m.mode)) return m.mode;
	}
	return undefined;
}

/** Solo para pruebas: olvida lo leído para volver a leer el archivo. */
export function resetChatModesCache(): void {
	cache = null;
}
