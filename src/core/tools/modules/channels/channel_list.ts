/**
 * Tool: channel_list - Lista los canales configurados
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const channelListTool = {
	name: "channel_list",
	description: "Lista todos los canales de comunicacion configurados.",
	category: "canales",
	parameters: {
		type: "object",
		properties: {},
	},
	examples: [
		'"que canales tienes" -> channel_list({})',
		'"lista mis canales" -> channel_list({})',
	],
};

async function executeChannelList(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { listChannels } = await import("../../../channels/ChannelManager.js");
	const channels = listChannels();
	
	if (channels.length === 0) {
		return { 
			ok: true, 
			content: "No hay canales configurados. Usa channel_create para crear uno." 
		};
	}
	
	let output = "Canales configurados:\n\n";
	for (const ch of channels) {
		const statusIcon = ch.status === "active" ? "🟢" : ch.status === "error" ? "🔴" : "⚪";
		output += `${statusIcon} ${ch.name} (${ch.type})\n`;
		output += `   ID: ${ch.id}\n`;
		output += `   Estado: ${ch.status}\n`;
		if (ch.lastError) output += `   Error: ${ch.lastError}\n`;
		output += "\n";
	}
	
	return { ok: true, content: output };
}

registerToolExecutor("channel_list", executeChannelList);
