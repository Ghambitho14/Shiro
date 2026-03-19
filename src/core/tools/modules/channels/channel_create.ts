/**
 * Tool: channel_create - Crea un nuevo canal
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const channelCreateTool = {
	name: "channel_create",
	description: "Crea un nuevo canal de comunicacion (Telegram, Discord, Slack). USA ESTO cuando el usuario quiera conectarse desde otra plataforma.",
	category: "canales",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Nombre del canal (ej: 'Mi Telegram')" },
			type: { type: "string", description: "Tipo: telegram, discord, slack" },
			token: { type: "string", description: "Token del bot/API" },
		},
		required: ["name", "type", "token"],
	},
	examples: [
		'"creame un canal de Telegram" -> channel_create({name: "Telegram", type: "telegram", token: "mi-token"})',
	],
};

async function executeChannelCreate(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { createChannel, startChannel } = await import("../../../channels/ChannelManager.js");
	const name = String(args.name ?? "").trim();
	const type = String(args.type ?? "").trim();
	const token = String(args.token ?? "").trim();
	
	if (!name) return { ok: false, content: "El nombre es requerido" };
	if (!type) return { ok: false, content: "El tipo es requerido (telegram, discord, slack)" };
	if (!token) return { ok: false, content: "El token es requerido" };
	
	if (!["telegram", "discord", "slack"].includes(type)) {
		return { ok: false, content: `Tipo '${type}' no soportado. Usa: telegram, discord, slack` };
	}
	
	try {
		const channel = createChannel(name, type as "telegram" | "discord" | "slack", { token });
		
		let msg = `Canal creado: "${name}" (${type})\n`;
		msg += `   ID: ${channel.id}\n`;
		msg += `   Estado: ${channel.status}\n\n`;
		
		// Intentar iniciar automaticamente
		const result = await startChannel(channel.id);
		if (result.ok) {
			msg += `Canal iniciado correctamente!\n\n`;
			msg += `Para ${type}: Busca tu bot y enviale /start`;
		} else {
			msg += `El canal se creo pero no se pudo iniciar: ${result.error}`;
		}
		
		return { ok: true, content: msg };
	} catch (err) {
		return { 
			ok: false, 
			content: "Error al crear canal: " + (err instanceof Error ? err.message : String(err)) 
		};
	}
}

registerToolExecutor("channel_create", executeChannelCreate);
