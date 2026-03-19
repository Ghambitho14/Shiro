/**
 * Tool: channel_delete - Elimina un canal
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const channelDeleteTool = {
	name: "channel_delete",
	description: "Elimina un canal configurado.",
	category: "canales",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "ID del canal" },
		},
		required: ["id"],
	},
};

async function executeChannelDelete(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { deleteChannel } = await import("../../../channels/ChannelManager.js");
	const id = String(args.id ?? "").trim();
	
	if (!id) return { ok: false, content: "El ID del canal es requerido" };
	
	const deleted = deleteChannel(id);
	if (deleted) {
		return { ok: true, content: `Canal eliminado: ${id}` };
	}
	return { ok: false, content: "Canal no encontrado" };
}

registerToolExecutor("channel_delete", executeChannelDelete);
