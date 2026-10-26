/**
 * Servidores MCP que usa Shiro (data/mcp.json).
 *
 * Mismo formato que LM Studio, Claude Desktop o Cursor, para poder copiar y pegar:
 *   { "mcpServers": { "nombre": { "command": "npx", "args": [...], "env": {...} } } }
 *   { "mcpServers": { "nombre": { "url": "https://...", "headers": {...} } } }
 * Campos propios (los mismos que usa Cline): disabled, alwaysAllow (tools que no piden permiso)
 * y disabledTools (tools que no se ofrecen al modelo).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "../../config/config.js";

export const MCP_CONFIG_FILE = join(DATA_DIR, "mcp.json");

const serverSchema = z
	.object({
		command: z.string().trim().min(1).optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string()).optional(),
		cwd: z.string().trim().min(1).optional(),
		url: z.string().trim().url().optional(),
		/** stdio | http | sse. Si falta se deduce (command → stdio, url → http con respaldo sse). */
		type: z.string().optional(),
		headers: z.record(z.string()).optional(),
		disabled: z.boolean().optional(),
		alwaysAllow: z.array(z.string()).optional(),
		disabledTools: z.array(z.string()).optional(),
	})
	.passthrough()
	.refine((s) => Boolean(s.command) !== Boolean(s.url), { message: 'cada servidor necesita "command" (programa) o "url" (remoto), no los dos' });

export type McpServerConfig = z.infer<typeof serverSchema>;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

export function isValidServerName(name: string): boolean {
	return NAME_RE.test(name);
}

/** Valida el contenido completo de mcp.json. Lanza un Error legible si algo está mal. */
export function parseMcpJson(text: string): Record<string, McpServerConfig> {
	let data: unknown;
	try {
		data = text.trim() ? JSON.parse(text) : {};
	} catch (err) {
		throw new Error(`El JSON no es válido: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error('Debe ser un objeto: { "mcpServers": { ... } }');
	const raw = (data as { mcpServers?: unknown }).mcpServers ?? {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('"mcpServers" debe ser un objeto con un servidor por nombre.');
	const out: Record<string, McpServerConfig> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!isValidServerName(name)) throw new Error(`Nombre de servidor no válido: "${name}" (usa letras, números, espacios, - _ .; máx. 40).`);
		const parsed = serverSchema.safeParse(value);
		if (!parsed.success) {
			const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(servidor)"}: ${i.message}`).join("; ");
			throw new Error(`Servidor "${name}": ${problems}`);
		}
		out[name] = parsed.data;
	}
	return out;
}

export function loadMcpServers(): { servers: Record<string, McpServerConfig>; error?: string } {
	if (!existsSync(MCP_CONFIG_FILE)) return { servers: {} };
	try {
		return { servers: parseMcpJson(readFileSync(MCP_CONFIG_FILE, "utf-8")) };
	} catch (err) {
		return { servers: {}, error: `data/mcp.json tiene un error: ${err instanceof Error ? err.message : String(err)}` };
	}
}

export function readMcpRaw(): string {
	return existsSync(MCP_CONFIG_FILE) ? readFileSync(MCP_CONFIG_FILE, "utf-8") : `{\n  "mcpServers": {}\n}\n`;
}

export function saveMcpServers(servers: Record<string, McpServerConfig>): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(MCP_CONFIG_FILE, JSON.stringify({ mcpServers: servers }, null, 2) + "\n", "utf-8");
}

/** Guarda el texto tal cual (desde el editor de la web) tras validarlo. */
export function writeMcpRaw(text: string): Record<string, McpServerConfig> {
	const servers = parseMcpJson(text);
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(MCP_CONFIG_FILE, text.endsWith("\n") ? text : text + "\n", "utf-8");
	return servers;
}

/** Parte "npx -y @paquete/mcp --opcion 'con espacios'" en programa y argumentos. */
export function splitCommandLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: '"' | "'" | null = null;
	let has = false;
	for (const ch of line.trim()) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has || cur) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
		}
	}
	if (has || cur) out.push(cur);
	return out;
}

// ───────────────────────────── importar de otras aplicaciones ─────────────────────────────

export type McpImportSource = { id: string; label: string; file: string };

export function mcpImportSources(home = homedir()): McpImportSource[] {
	const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
	const claudeDesktop =
		process.platform === "win32"
			? join(appData, "Claude", "claude_desktop_config.json")
			: process.platform === "darwin"
				? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
				: join(home, ".config", "Claude", "claude_desktop_config.json");
	const vscode =
		process.platform === "win32"
			? join(appData, "Code", "User", "mcp.json")
			: process.platform === "darwin"
				? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
				: join(home, ".config", "Code", "User", "mcp.json");
	return [
		{ id: "lmstudio", label: "LM Studio", file: join(home, ".lmstudio", "mcp.json") },
		{ id: "claude-desktop", label: "Claude Desktop", file: claudeDesktop },
		{ id: "claude-code", label: "Claude Code", file: join(home, ".claude.json") },
		{ id: "cursor", label: "Cursor", file: join(home, ".cursor", "mcp.json") },
		{ id: "vscode", label: "VS Code", file: vscode },
		{ id: "opencode", label: "OpenCode", file: join(home, ".config", "opencode", "opencode.json") },
	];
}

/** El propio servidor MCP de Shiro no se importa: Shiro acabaría arrancándose a sí mismo. */
function isShiroItself(cfg: McpServerConfig): boolean {
	return [cfg.command ?? "", ...(cfg.args ?? [])].some((a) => /shiro-mcp\.mjs|src[\\/]mcp[\\/]server\.ts/i.test(a));
}

/** Convierte las entradas de cada aplicación al formato de Shiro. Lo que no se entiende se ignora. */
export function extractServers(sourceId: string, data: unknown): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	if (!data || typeof data !== "object") return out;
	const obj = data as Record<string, unknown>;
	let entries: Record<string, unknown> = {};
	if (sourceId === "opencode") {
		for (const [name, v] of Object.entries((obj.mcp as Record<string, unknown>) ?? {})) {
			const e = v as { type?: string; command?: unknown; url?: string; environment?: Record<string, string>; headers?: Record<string, string>; enabled?: boolean };
			if (Array.isArray(e.command) && e.command.length) {
				entries[name] = { command: String(e.command[0]), args: e.command.slice(1).map(String), env: e.environment, disabled: e.enabled === false || undefined };
			} else if (typeof e.url === "string") {
				entries[name] = { url: e.url, headers: e.headers, disabled: e.enabled === false || undefined };
			}
		}
	} else {
		entries = ((sourceId === "vscode" ? obj.servers : obj.mcpServers) as Record<string, unknown>) ?? {};
	}
	for (const [rawName, value] of Object.entries(entries)) {
		const name = rawName.replace(/[^A-Za-z0-9 _.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40);
		if (!name || !value || typeof value !== "object") continue;
		const v = value as Record<string, unknown>;
		const candidate = {
			command: typeof v.command === "string" ? v.command : undefined,
			args: Array.isArray(v.args) ? v.args.map(String) : undefined,
			env: v.env && typeof v.env === "object" ? (v.env as Record<string, string>) : undefined,
			url: typeof v.url === "string" ? v.url : undefined,
			type: typeof v.type === "string" && v.type !== "stdio" ? v.type : undefined,
			headers: v.headers && typeof v.headers === "object" ? (v.headers as Record<string, string>) : undefined,
			disabled: v.disabled === true || undefined,
		};
		const parsed = serverSchema.safeParse(candidate);
		if (parsed.success && !isShiroItself(parsed.data)) out[name] = parsed.data;
	}
	return out;
}

export function readImportSource(source: McpImportSource): Record<string, McpServerConfig> {
	if (!existsSync(source.file)) return {};
	try {
		return extractServers(source.id, JSON.parse(readFileSync(source.file, "utf-8")));
	} catch {
		return {};
	}
}
