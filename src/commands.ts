/**
 * Comandos del chat ("/ayuda", "/modelo"…). Los usan la web y la terminal.
 * "/<habilidad> mensaje" no es un comando: hace que Shiro use esa habilidad (ver matchSkillCommand).
 */
import { getConfig, setConfig } from "./config/config.js";
import { getState } from "./store.js";
import { PROVIDER_PRESETS, activeModelTuning, maskKey, resolveLLMSettings } from "./core/llm/providers.js";
import { getEnabledSkills } from "./core/skills/SkillLoader.js";
import { mcpManager } from "./core/mcp/McpManager.js";
import { loadAgents } from "./core/agents/registry.js";

export interface CommandResult {
	executed: boolean;
	content: string;
}

export type CommandInfo = { name: string; aliases: string[]; usage?: string; description: string };

/** Lista para /ayuda y para el menú que aparece al escribir "/" en la web. */
export const COMMANDS: CommandInfo[] = [
	{ name: "ayuda", aliases: ["help"], description: "Lista de comandos" },
	{ name: "nuevo", aliases: ["new", "limpiar", "clear", "reset"], description: "Empezar una conversación nueva" },
	{ name: "estado", aliases: ["status"], description: "Modelo, herramientas, habilidades y MCP" },
	{ name: "modelo", aliases: ["model", "provider"], usage: "/modelo [nombre]", description: "Ver el modelo o cambiarlo" },
	{ name: "habilidades", aliases: ["skills"], description: "Habilidades activas (escribe /nombre para usar una)" },
	{ name: "mcp", aliases: [], description: "Servidores MCP y sus herramientas" },
	{ name: "agentes", aliases: ["agents"], description: "Agentes que puedes activar y cómo usarlos" },
	{ name: "herramientas", aliases: ["tools"], usage: "/herramientas on|off", description: "Activar o desactivar las herramientas" },
	{ name: "explica", aliases: ["explain"], usage: "/explica off|breve|on", description: "Que diga qué herramientas usó" },
];

function findCommand(word: string): CommandInfo | undefined {
	const w = word.toLowerCase();
	return COMMANDS.find((c) => c.name === w || c.aliases.includes(w));
}

/** "/nombre-de-habilidad resto" → la habilidad a usar (si existe y no es un comando). */
export function matchSkillCommand(message: string): { skill: string; rest: string } | null {
	const m = /^\/(\S+)\s*([\s\S]*)$/.exec(message.trim());
	if (!m || findCommand(m[1])) return null;
	const q = m[1].toLowerCase();
	const skill = getEnabledSkills().find((s) => s.name.toLowerCase() === q);
	return skill ? { skill: skill.name, rest: m[2].trim() } : null;
}

function onOff(v: boolean): string {
	return v ? "activado" : "desactivado";
}

function statusText(): string {
	const cfg = getConfig();
	const s = resolveLLMSettings();
	const skills = getEnabledSkills().length;
	const servers = mcpManager.status();
	const ready = servers.filter((x) => x.state === "ready");
	const mcpTools = mcpManager.getToolNames().length;
	return `**Estado de ${getState().name}**

- **Modelo:** ${s.model} (${PROVIDER_PRESETS[s.provider].label})
- **Herramientas:** ${onOff(cfg.autonomousMode)} · perfil ${activeModelTuning().toolProfile} · permisos: ${cfg.approvalMode === "ask" ? "preguntar" : cfg.approvalMode === "allow" ? "no preguntar" : "bloquear"}
- **Control del PC:** ${onOff(cfg.pcControl)}
- **Habilidades activas:** ${skills}
- **MCP:** ${servers.length ? `${ready.length} de ${servers.length} servidores conectados, ${mcpTools} herramientas` : "ningún servidor"}`;
}

function helpText(): string {
	const lines = COMMANDS.map((c) => `- \`${c.usage ?? "/" + c.name}\` — ${c.description}`);
	const skills = getEnabledSkills();
	const skillHint = skills.length
		? `\n\n**Habilidades:** escribe \`/${skills[0].name} lo que quieras\` para que use una habilidad concreta. \`/habilidades\` las lista todas.`
		: "";
	return `**Comandos**\n\n${lines.join("\n")}${skillHint}`;
}

function modelText(args: string[]): string {
	const wanted = args.join(" ").trim();
	if (wanted) {
		setConfig({ llmModel: wanted });
		return `Listo: ahora uso **${resolveLLMSettings().model}**. Si no responde, vuelve al anterior con \`/modelo nombre\` o en Ajustes → Modelo.`;
	}
	const s = resolveLLMSettings();
	const preset = PROVIDER_PRESETS[s.provider];
	return `**Modelo:** ${s.model}
- Proveedor: ${preset.label}
${preset.managed ? "- Motor: llama.cpp integrado (lo abre Shiro con el archivo GGUF)" : `- Dirección: ${s.baseUrl}`}
- API key: ${s.apiKey ? maskKey(s.apiKey) : preset.needsApiKey ? "falta" : "no hace falta"}

Para cambiarlo: \`/modelo nombre\`, el selector de arriba o Ajustes → Modelo.`;
}

function skillsText(): string {
	const skills = getEnabledSkills();
	if (!skills.length) return "No hay habilidades activas. Añádelas en **Ajustes → Habilidades** (puedes crear las tuyas o usar las de Claude Code, Codex, OpenCode…).";
	const lines = skills.map((s) => `- \`/${s.name}\` — ${s.description.replace(/\s+/g, " ").slice(0, 140)}`);
	return `**Habilidades activas (${skills.length})**\n\nShiro las usa solo cuando encajan. Para forzar una: \`/nombre lo que quieras\`.\n\n${lines.join("\n")}`;
}

function mcpText(): string {
	const servers = mcpManager.status();
	const cfgError = mcpManager.getConfigError();
	if (!servers.length) return `${cfgError ? `⚠️ ${cfgError}\n\n` : ""}No hay servidores MCP. Añádelos en **Ajustes → Conectores MCP**.`;
	const icon = { ready: "🟢", connecting: "🟡", error: "🔴", off: "⚪" } as const;
	const label = { ready: "conectado", connecting: "conectando…", error: "error", off: "apagado" } as const;
	const lines = servers.map((s) => {
		const tools = s.tools.filter((t) => t.enabled).length;
		const extra = s.state === "ready" ? ` · ${tools} herramientas` : s.error ? ` · ${s.error}` : "";
		return `- ${icon[s.state]} **${s.name}** — ${label[s.state]}${extra}`;
	});
	return `**Servidores MCP**\n\n${lines.join("\n")}${cfgError ? `\n\n⚠️ ${cfgError}` : ""}`;
}

function agentsText(): string {
	const { agents, error } = loadAgents();
	if (error) return `⚠️ ${error}`;
	if (!agents.length) return "Todavía no hay agentes. Créalos en **Ajustes → Agentes**.";
	const wake = getConfig().wakeWord;
	const lines = agents.map((a) => {
		const model = a.model ? `${a.provider ? `${PROVIDER_PRESETS[a.provider].title} · ` : ""}${a.model}` : "el modelo de Ajustes";
		return `- **${a.name}**${a.description ? ` — ${a.description}` : ""} (${model})`;
	});
	return [
		"**Agentes**",
		"",
		...lines,
		"",
		`Para hablar con uno: «${wake}, activa ${agents[0].name}». Dentro de la sala: «${agents[0].name}, agrega a …», nombra a un agente para que responda él, «gracias …, puedes irte» o «…, ahora te encargas tú».`,
	].join("\n");
}

export function parseCommand(message: string, _sessionId?: string): CommandResult | null {
	const trimmed = message.trim();
	if (!trimmed.startsWith("/")) return null;

	const [word = "", ...args] = trimmed.slice(1).split(/\s+/);
	const cmd = findCommand(word);
	if (!cmd) {
		if (matchSkillCommand(trimmed)) return null; // lo responde el modelo usando esa habilidad
		// Rutas de archivo ("/home/…") o texto normal que empieza por "/": no es un comando.
		if (!/^[a-záéíóúñ-]+$/i.test(word)) return null;
		return { executed: true, content: `No conozco el comando \`/${word}\`. Escribe \`/ayuda\` para ver la lista.` };
	}

	switch (cmd.name) {
		case "ayuda":
			return { executed: true, content: helpText() };
		case "nuevo":
			return { executed: true, content: "Para empezar de cero pulsa **Nuevo chat** (Ctrl+Mayús+O)." };
		case "estado":
			return { executed: true, content: statusText() };
		case "modelo":
			return { executed: true, content: modelText(args) };
		case "habilidades":
			return { executed: true, content: skillsText() };
		case "mcp":
			return { executed: true, content: mcpText() };
		case "agentes":
			return { executed: true, content: agentsText() };
		case "herramientas": {
			const v = (args[0] ?? "").toLowerCase();
			const on = ["on", "si", "sí", "activar", "1"].includes(v);
			const off = ["off", "no", "desactivar", "0"].includes(v);
			if (!on && !off) {
				return { executed: true, content: `Las herramientas están **${onOff(getConfig().autonomousMode)}**. Usa \`/herramientas on\` o \`/herramientas off\`.` };
			}
			setConfig({ autonomousMode: on });
			return {
				executed: true,
				content: on ? "Herramientas **activadas**: puedo buscar en internet, usar archivos, recordatorios, habilidades y MCP." : "Herramientas **desactivadas**: solo conversaré.",
			};
		}
		case "explica": {
			const raw = (args[0] ?? "").toLowerCase();
			const mode = raw === "breve" || raw === "brief" ? "brief" : raw === "off" || raw === "on" ? raw : "";
			if (!mode) {
				return {
					executed: true,
					content: `Ahora: \`${getConfig().explainMode}\`. Usa \`/explica off|breve|on\`:\n- off: no menciona las herramientas\n- breve: una nota corta si usó alguna\n- on: lista de las herramientas usadas`,
				};
			}
			setConfig({ explainMode: mode });
			return { executed: true, content: `Listo: \`/explica ${raw}\`.` };
		}
		default:
			return null;
	}
}

/** Quita el formato Markdown básico para mostrar las respuestas de comandos en la terminal. */
export function plainText(markdown: string): string {
	return markdown.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
}
