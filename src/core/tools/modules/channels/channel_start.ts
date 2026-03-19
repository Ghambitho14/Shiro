/**
 * Tool: channel_start - Inicia un canal
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const channelStartTool = {
	name: "channel_start",
	description: "Inicia un canal existente. El canal debe estar creado primero.",
	category: "canales",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "ID del canal" },
		},
		required: ["id"],
	},
};

async function executeChannelStart(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { getChannel, startChannel } = await import("../../../channels/ChannelManager.js");
	const id = String(args.id ?? "").trim();
	
	if (!id) return { ok: false, content: "El ID del canal es requerido" };
	
	const channel = getChannel(id);
	if (!channel) return { ok: false, content: "Canal no encontrado" };
	
	const result = await startChannel(id);
	if (result.ok) {
		return { 
			ok: true, 
			content: `Canal "${channel.name}" iniciado correctamente!\n\nPara ${channel.type}: Busca tu bot y enviale /start` 
		};
	}
	return { ok: false, content: `Error al iniciar: ${result.error}` };
}

registerToolExecutor("channel_start", executeChannelStart);
