/**
 * «Rehacer la estructura» (Ajustes → Datos): vuelve a crear en la carpeta Shiro lo que falte, sin
 * cambiar ni borrar lo que ya hay. Las notas que lee Aku salen de la copia de data/copia-obsidian
 * (o del texto por defecto); las copias de chats y Recordatorios.md, de los datos de este equipo.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatBackendFor, mirrorChatToObsidian } from "../chat/backends.js";
import { sanitizeMessages } from "../chat/ChatStore.js";
import { reminderBackendFor } from "../core/reminders/reminders.js";
import { getWorkspaceDir, rebuildWorkspace } from "../workspace.js";
import { hasChatNote, obsidianRoot, writeRemindersNote } from "./obsidian.js";
import { currentStorage, vaultOf } from "./storage.js";

export type RebuildResult = { restored: number; chats: number; reminders: boolean };

export async function rebuildStructure(): Promise<RebuildResult> {
	const result: RebuildResult = { ...rebuildWorkspace(), chats: 0, reminders: false };
	const s = currentStorage();
	if (s.kind !== "obsidian") return result;
	const vault = vaultOf(s);
	// Si la bóveda no está (disco desconectado…), no se crea nada en una ruta que no existe.
	if (getWorkspaceDir() !== obsidianRoot(vault)) return result;

	const chats = chatBackendFor(s, sanitizeMessages);
	for (const meta of await chats.list()) {
		if (hasChatNote(vault, meta.id)) continue;
		const chat = await chats.get(meta.id);
		if (chat) mirrorChatToObsidian(vault, chat), result.chats++;
	}
	if (!existsSync(join(obsidianRoot(vault), "Recordatorios.md"))) {
		writeRemindersNote(vault, await reminderBackendFor(s).load());
		result.reminders = true;
	}
	return result;
}
