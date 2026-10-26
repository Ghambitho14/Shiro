/**
 * "Llevar mis datos": copia chats, recuerdos, recordatorios y notas de memoria de un almacén a otro
 * al cambiar en Ajustes → Datos. No borra nada del sitio de origen.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chatBackendFor, mirrorChatToObsidian } from "../chat/backends.js";
import { sanitizeMessages } from "../chat/ChatStore.js";
import { memoryBackendFor } from "../core/memory/memories.js";
import { reminderBackendFor, type Reminder } from "../core/reminders/reminders.js";
import { workspaceDirFor } from "../workspace.js";
import { vaultOf, type StorageSettings } from "./storage.js";

export type MigrationResult = { chats: number; memories: number; reminders: number; files: number };

/** Local y Obsidian comparten el índice de chats y la lista de recordatorios de este equipo. */
const onThisDevice = (s: StorageSettings) => s.kind !== "supabase";

export async function migrateStorage(from: StorageSettings, to: StorageSettings): Promise<MigrationResult> {
	const result: MigrationResult = { chats: 0, memories: 0, reminders: 0, files: 0 };

	// Chats (y a qué chat va cada conversación de WhatsApp/Telegram).
	const source = chatBackendFor(from, sanitizeMessages);
	if (onThisDevice(from) && onThisDevice(to)) {
		// Mismo índice: con Obsidian solo falta escribir la nota de cada chat.
		if (to.kind === "obsidian") {
			const vault = vaultOf(to);
			for (const meta of await source.list()) {
				const chat = await source.get(meta.id);
				if (chat) mirrorChatToObsidian(vault, chat), result.chats++;
			}
		}
	} else {
		const target = chatBackendFor(to, sanitizeMessages);
		for (const meta of await source.list()) {
			const chat = await source.get(meta.id);
			if (!chat) continue;
			await target.insert(chat);
			result.chats++;
		}
		for (const link of await source.links()) await target.setLink(link.channel, link.externalId, link.sessionId);
	}

	// Recuerdos: cada tipo de almacén tiene los suyos.
	if (from.kind !== to.kind || from.obsidianVault !== to.obsidianVault) {
		const target = memoryBackendFor(to);
		const already = new Set((await target.all()).map((m) => m.id));
		for (const memory of await memoryBackendFor(from).all()) {
			if (already.has(memory.id)) continue;
			await target.add({ ...memory, source: undefined });
			result.memories++;
		}
	}

	// Recordatorios: se juntan los dos listados (si un id está en ambos, gana el de origen).
	if (!(onThisDevice(from) && onThisDevice(to)) || to.kind === "obsidian") {
		const incoming = await reminderBackendFor(from).load();
		const target = reminderBackendFor(to);
		const merged = new Map<string, Reminder>();
		for (const r of await target.load()) merged.set(r.id, r);
		for (const r of incoming) merged.set(r.id, r);
		await target.save([...merged.values()]);
		result.reminders = incoming.length;
	}

	// Notas de memoria (SOUL.md, MEMORY.md, memory/…) y archivos del workspace. No se copian las
	// habilidades ni las copias legibles que solo existen en Obsidian (chats, recuerdos y recordatorios).
	const skip = new Set(["skills", "Chats", "Recuerdos", "Recordatorios.md"]);
	const fromDir = workspaceDirFor(from);
	const toDir = workspaceDirFor(to);
	if (resolve(fromDir) !== resolve(toDir) && existsSync(fromDir)) {
		for (const entry of readdirSync(fromDir)) {
			if (skip.has(entry) || entry.startsWith(".")) continue;
			cpSync(join(fromDir, entry), join(toDir, entry), { recursive: true, force: true });
			result.files++;
		}
	}

	return result;
}
