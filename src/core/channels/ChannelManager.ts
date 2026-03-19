/**
 * Channel Manager - Sistema para que Shiro se auto-cree canales
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "data");
const CHANNELS_DIR = join(DATA_DIR, "channels");

export interface Channel {
	id: string;
	name: string;
	type: "telegram" | "discord" | "slack" | "whatsapp" | "web";
	status: "inactive" | "active" | "error";
	config: Record<string, unknown>;
	createdAt: string;
	lastError?: string;
}

function ensureDir() {
	if (!existsSync(CHANNELS_DIR)) {
		mkdirSync(CHANNELS_DIR, { recursive: true });
	}
}

function loadChannels(): Channel[] {
	ensureDir();
	const file = join(CHANNELS_DIR, "channels.json");
	if (!existsSync(file)) return [];
	try {
		return JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return [];
	}
}

function saveChannels(channels: Channel[]): void {
	ensureDir();
	const file = join(CHANNELS_DIR, "channels.json");
	writeFileSync(file, JSON.stringify(channels, null, 2), "utf-8");
}

export function listChannels(): Channel[] {
	return loadChannels();
}

export function getChannel(id: string): Channel | undefined {
	return loadChannels().find(c => c.id === id);
}

export function createChannel(
	name: string,
	type: Channel["type"],
	config: Record<string, unknown>,
): Channel {
	const channels = loadChannels();
	
	const channel: Channel = {
		id: `ch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		name,
		type,
		status: "inactive",
		config,
		createdAt: new Date().toISOString(),
	};
	
	channels.push(channel);
	saveChannels(channels);
	
	return channel;
}

export function updateChannel(id: string, updates: Partial<Channel>): Channel | undefined {
	const channels = loadChannels();
	const idx = channels.findIndex(c => c.id === id);
	if (idx === -1) return undefined;
	
	channels[idx] = { ...channels[idx], ...updates };
	saveChannels(channels);
	
	return channels[idx];
}

export function deleteChannel(id: string): boolean {
	const channels = loadChannels();
	const idx = channels.findIndex(c => c.id === id);
	if (idx === -1) return false;
	
	channels.splice(idx, 1);
	saveChannels(channels);
	return true;
}

export async function startChannel(id: string): Promise<{ ok: boolean; error?: string }> {
	const channel = getChannel(id);
	if (!channel) return { ok: false, error: "Canal no encontrado" };
	
	if (channel.type === "telegram") {
		return startTelegramChannel(channel);
	}
	
	return { ok: false, error: `Tipo ${channel.type} no soportado aún` };
}

async function startTelegramChannel(channel: Channel): Promise<{ ok: boolean; error?: string }> {
	const token = channel.config.token as string;
	if (!token) {
		return { ok: false, error: "Token no proporcionado" };
	}
	
	// Verificar el token con la API de Telegram
	try {
		const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
		const data = await response.json() as { ok: boolean; result?: { username: string; first_name: string } };
		
		if (!data.ok || !data.result) {
			return { ok: false, error: "Token inválido o bot no encontrado" };
		}
		
		// Actualizar info del canal
		updateChannel(channel.id, {
			status: "active",
			config: {
				...channel.config,
				botUsername: data.result.username,
				botName: data.result.first_name,
			},
		});
		
		// Escribir archivo del bridge de Telegram
		const bridgeCode = generateTelegramBridge(channel);
		const bridgeFile = join(CHANNELS_DIR, `telegram_${channel.id}.ts`);
		writeFileSync(bridgeFile, bridgeCode, "utf-8");
		
		return {
			ok: true,
			error: undefined,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		updateChannel(channel.id, { status: "error", lastError: error });
		return { ok: false, error };
	}
}

function generateTelegramBridge(channel: Channel): string {
	const token = channel.config.token as string;
	
	return `/**
 * Telegram Bridge - Auto-generado por Shiro
 * Canal: ${channel.name}
 */

import { getLLM } from "../../llm/getLLM.js";
import { runAgent } from "../../agent/Agent.js";
import { createSessionMemoryStore } from "../../memory/SessionMemoryStore.js";
import { MemoryManager } from "../../memory/MemoryManager.js";
import { getUserProfile } from "../../user-profile.js";
import { buildWorkspaceContext } from "../../workspace.js";

const BOT_TOKEN = "${token}";
const API_URL = \`https://api.telegram.org/bot\${BOT_TOKEN}\`;
const SHIRO_NAME = "Shiro";

async function sendMessage(chatId: number, text: string): Promise<void> {
	await fetch(\`\${API_URL}/sendMessage\`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
	});
}

async function handleUpdate(update: { message?: { chat: { id: number }; text?: string }; edited_message?: unknown }): Promise<void> {
	if (!update.message?.text) return;
	
	const chatId = update.message.chat.id;
	const text = update.message.text;
	
	console.log(\`[Telegram] Mensaje de \${chatId}: \${text}\`);
	
	try {
		const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
		const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
		
		const response = await runAgent(text, {
			llm: getLLM(),
			memory,
			agentName: SHIRO_NAME,
			tokenBudget: 8000,
			usePlanner: true,
			userProfile: getUserProfile(),
		}, workspaceContext ?? undefined);
		
		await sendMessage(chatId, response || "(sin respuesta)");
	} catch (err) {
		console.error("[Telegram] Error:", err);
		await sendMessage(chatId, "Error al procesar mensaje");
	}
}

async function main(): Promise<void> {
	console.log("[Telegram] Bridge iniciado para ${channel.name}");
	
	let offset = 0;
	while (true) {
		try {
			const response = await fetch(\`\${API_URL}/getUpdates?offset=\${offset}&timeout=30\`);
			const data = await response.json() as { ok: boolean; result: unknown[] };
			
			if (data.ok && data.result.length > 0) {
				for (const update of data.result) {
					await handleUpdate(update as { message?: { chat: { id: number }; text?: string }; edited_message?: unknown });
					offset = ((update as { update_id: number }).update_id) + 1;
				}
			}
		} catch (err) {
			console.error("[Telegram] Error en polling:", err);
			await new Promise(r => setTimeout(r, 5000));
		}
	}
}

main().catch(console.error);
`;
}

export function getChannelTemplates(): Array<{ type: Channel["type"]; name: string; description: string; requiredFields: string[] }> {
	return [
		{
			type: "telegram",
			name: "Telegram Bot",
			description: "Conectar con un bot de Telegram",
			requiredFields: ["token"],
		},
		{
			type: "discord",
			name: "Discord Bot",
			description: "Conectar con un bot de Discord",
			requiredFields: ["token"],
		},
		{
			type: "slack",
			name: "Slack App",
			description: "Conectar con una app de Slack",
			requiredFields: ["token", "webhookUrl"],
		},
	];
}
