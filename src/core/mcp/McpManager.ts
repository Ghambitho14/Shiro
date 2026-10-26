/**
 * Cliente MCP: Shiro se conecta a servidores MCP externos (GitHub, Notion, navegador,
 * bases de datos…) y ofrece sus herramientas al modelo como "mcp__<servidor>__<tool>".
 *
 * Las conexiones se abren al arrancar la web o la terminal y se mantienen abiertas.
 * Nada de console.log aquí: en modo MCP stdout es del protocolo (se usa el logger).
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef } from "../llm/LLMClient.js";
import type { ToolResult } from "../agent/Types.js";
import { logger } from "../logger.js";
import { loadMcpServers, type McpServerConfig } from "./mcpConfig.js";
import { APP_VERSION } from "../../runtime.js";

export type McpState = "off" | "connecting" | "ready" | "error";

export type McpToolInfo = {
	/** Nombre original en el servidor. */
	name: string;
	/** Nombre que ve el modelo (único entre todos los servidores). */
	exposed: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
};

type Conn = {
	name: string;
	config: McpServerConfig;
	signature: string;
	state: McpState;
	error?: string;
	client?: Client;
	transport?: Transport;
	tools: McpToolInfo[];
	stderr: string[];
	connecting?: Promise<void>;
	closing?: boolean;
	serverVersion?: string;
};

export type McpServerStatus = {
	name: string;
	kind: "stdio" | "http";
	target: string;
	state: McpState;
	error?: string;
	serverVersion?: string;
	disabled: boolean;
	tools: { name: string; exposed: string; description: string; enabled: boolean; alwaysAllow: boolean; readOnly: boolean }[];
	log: string[];
};

const PREFIX = "mcp__";
const CONNECT_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_DESCRIPTION = 1000;

export function isMcpToolName(name: string): boolean {
	return name.startsWith(PREFIX);
}

function slug(s: string): string {
	return s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/** Nombre para el modelo: solo [A-Za-z0-9_-] y como mucho 64 caracteres (límite de OpenAI). */
export function exposedToolName(server: string, tool: string): string {
	const full = `${PREFIX}${slug(server)}__${slug(tool)}`;
	if (full.length <= 64) return full;
	const hash = createHash("sha1").update(`${server}\n${tool}`).digest("hex").slice(0, 6);
	return `${full.slice(0, 57)}_${hash}`;
}

/** Los esquemas de algunas tools traen campos que ciertos proveedores rechazan. */
function cleanSchema(schema: unknown): Record<string, unknown> {
	const s = schema && typeof schema === "object" ? { ...(schema as Record<string, unknown>) } : {};
	delete s.$schema;
	if (s.type !== "object") s.type = "object";
	if (!s.properties || typeof s.properties !== "object") s.properties = {};
	return s;
}

function describeError(err: unknown, cfg: McpServerConfig, stderr: string[] = []): string {
	const msg = err instanceof Error ? err.message : String(err);
	const code = (err as { code?: unknown })?.code;
	// En Windows un programa inexistente no da ENOENT: cmd.exe lo dice por stderr y se cierra.
	const notFound = stderr.some((l) => /no se reconoce como un comando|is not recognized as an internal|command not found|not found$/i.test(l));
	if (code === "ENOENT" || notFound) return `No encontré el programa "${cfg.command}". ¿Está instalado? (para npx hace falta Node.js; para uvx, uv).`;
	if (/401|unauthori[sz]ed/i.test(msg)) return "El servidor pide iniciar sesión (401). Si tiene API key, ponla en las cabeceras (Authorization: Bearer …). El inicio de sesión con navegador (OAuth) aún no está soportado.";
	if (/ECONNREFUSED|fetch failed/i.test(msg)) return `No pude conectar con ${cfg.url ?? cfg.command}: ¿está encendido?`;
	if (/timed? ?out/i.test(msg)) return "El servidor tardó demasiado en responder.";
	if (/Connection closed/i.test(msg)) return "El servidor se cerró al arrancar. Mira el registro para ver el motivo.";
	return msg.slice(0, 400);
}

export class McpManager {
	private conns = new Map<string, Conn>();
	private started = false;
	private configError?: string;
	private readonly version = APP_VERSION;

	/** `load` se puede cambiar en las pruebas para no leer data/mcp.json. */
	constructor(private readonly load: () => { servers: Record<string, McpServerConfig>; error?: string } = loadMcpServers) {}

	/** Conecta los servidores activados (sin esperar). Se puede llamar varias veces. */
	start(): void {
		if (this.started) return;
		this.started = true;
		void this.reload();
	}

	isStarted(): boolean {
		return this.started;
	}

	/** Relee data/mcp.json: cierra lo que se quitó o cambió y conecta lo nuevo. */
	async reload(): Promise<void> {
		this.started = true;
		const { servers, error } = this.load();
		this.configError = error;
		for (const [name, conn] of this.conns) {
			const cfg = servers[name];
			if (!cfg || this.signature(cfg) !== conn.signature) {
				await this.close(conn);
				this.conns.delete(name);
			} else {
				conn.config = cfg; // alwaysAllow / disabledTools pueden cambiar sin reconectar
			}
		}
		for (const [name, cfg] of Object.entries(servers)) {
			if (this.conns.has(name)) continue;
			const conn: Conn = { name, config: cfg, signature: this.signature(cfg), state: "off", tools: [], stderr: [] };
			this.conns.set(name, conn);
			if (!cfg.disabled) void this.connect(conn);
		}
	}

	/** Vuelve a arrancar un servidor (no espera a que conecte: la web va mirando el estado). */
	async restart(name: string): Promise<void> {
		const conn = this.conns.get(name);
		if (!conn) return;
		await this.close(conn);
		// Si estaba arrancando, esa conexión termina (cancelada) antes de abrir la nueva.
		if (conn.connecting) await conn.connecting.catch(() => {});
		if (!conn.config.disabled) void this.connect(conn);
	}

	/** Espera (como mucho timeoutMs) a que terminen las conexiones en curso. */
	async whenReady(timeoutMs = 10_000): Promise<void> {
		const pending = [...this.conns.values()].map((c) => c.connecting).filter(Boolean);
		if (!pending.length) return;
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.allSettled(pending),
			new Promise<void>((r) => {
				timer = setTimeout(r, timeoutMs);
				timer.unref?.();
			}),
		]);
		clearTimeout(timer);
	}

	getConfigError(): string | undefined {
		return this.configError;
	}

	status(): McpServerStatus[] {
		return [...this.conns.values()].map((c) => {
			const allow = new Set(c.config.alwaysAllow ?? []);
			const off = new Set(c.config.disabledTools ?? []);
			return {
				name: c.name,
				kind: c.config.url ? "http" : "stdio",
				target: c.config.url ?? [c.config.command, ...(c.config.args ?? [])].join(" "),
				state: c.state,
				error: c.error,
				serverVersion: c.serverVersion,
				disabled: c.config.disabled === true,
				tools: c.tools.map((t) => ({
					name: t.name,
					exposed: t.exposed,
					description: t.description,
					enabled: !off.has(t.name),
					alwaysAllow: allow.has(t.name) || allow.has("*"),
					readOnly: t.readOnly,
				})),
				log: c.stderr.slice(-30),
			};
		});
	}

	/** Herramientas activas de los servidores conectados. */
	private activeTools(): { conn: Conn; tool: McpToolInfo }[] {
		const out: { conn: Conn; tool: McpToolInfo }[] = [];
		for (const conn of this.conns.values()) {
			if (conn.state !== "ready" || conn.config.disabled) continue;
			const off = new Set(conn.config.disabledTools ?? []);
			for (const tool of conn.tools) if (!off.has(tool.name)) out.push({ conn, tool });
		}
		return out;
	}

	getToolNames(): string[] {
		return this.activeTools().map((t) => t.tool.exposed);
	}

	getToolDefs(allowed?: Set<string>): ToolDef[] {
		return this.activeTools()
			.filter(({ tool }) => !allowed || allowed.has(tool.exposed))
			.map(({ conn, tool }) => ({
				type: "function" as const,
				function: {
					name: tool.exposed,
					description: `[${conn.name}] ${tool.description}`.slice(0, MAX_DESCRIPTION),
					parameters: tool.inputSchema as ToolDef["function"]["parameters"],
				},
			}));
	}

	/** Servidor y nombre original de una tool, para mostrarlo al usuario. */
	lookup(exposed: string): { server: string; tool: string; alwaysAllow: boolean } | undefined {
		for (const conn of this.conns.values()) {
			const tool = conn.tools.find((t) => t.exposed === exposed);
			if (!tool) continue;
			const allow = conn.config.alwaysAllow ?? [];
			return { server: conn.name, tool: tool.name, alwaysAllow: allow.includes(tool.name) || allow.includes("*") };
		}
		return undefined;
	}

	async callTool(exposed: string, args: Record<string, unknown>): Promise<ToolResult> {
		const found = this.activeTools().find((t) => t.tool.exposed === exposed);
		if (!found || !found.conn.client) return { ok: false, error: `La herramienta ${exposed} no está disponible (¿se desconectó el servidor MCP?).` };
		const { conn, tool } = found;
		try {
			const r = (await conn.client!.callTool({ name: tool.name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as { content?: unknown[]; isError?: boolean; structuredContent?: unknown; toolResult?: unknown };
			const text = formatContent(r);
			return r.isError ? { ok: false, error: text || `La herramienta ${tool.name} falló.` } : { ok: true, content: text || "(sin resultado)" };
		} catch (err) {
			return { ok: false, error: `${conn.name}/${tool.name}: ${describeError(err, conn.config)}` };
		}
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.conns.values()].map((c) => this.close(c)));
	}

	// ───────────────────────────── interno ─────────────────────────────

	/** Lo que obliga a reconectar si cambia (no incluye permisos ni tools apagadas). */
	private signature(cfg: McpServerConfig): string {
		return JSON.stringify([cfg.command, cfg.args, cfg.env, cfg.cwd, cfg.url, cfg.type, cfg.headers, cfg.disabled === true]);
	}

	private connect(conn: Conn): Promise<void> {
		if (conn.connecting) return conn.connecting;
		conn.state = "connecting";
		conn.error = undefined;
		conn.stderr = [];
		conn.closing = false;
		conn.connecting = (async () => {
			try {
				await this.open(conn);
				await this.refreshTools(conn);
				conn.state = "ready";
				logger.info(`MCP ${conn.name}: conectado (${conn.tools.length} herramientas)`);
			} catch (err) {
				// Se cerró a propósito mientras arrancaba (apagado, reinicio o salir de Shiro): no es un error.
				if (conn.closing) {
					conn.state = "off";
					return;
				}
				conn.state = "error";
				conn.error = describeError(err, conn.config, conn.stderr);
				logger.warn(`MCP ${conn.name}: ${conn.error}`);
				await this.close(conn, true);
			} finally {
				conn.connecting = undefined;
			}
		})();
		return conn.connecting;
	}

	private newClient(conn: Conn): Client {
		const client = new Client({ name: "shiro", version: this.version }, { capabilities: {} });
		client.onclose = () => {
			if (conn.closing || conn.state !== "ready") return;
			conn.state = "error";
			conn.error = "Se cerró la conexión con el servidor.";
			conn.tools = [];
		};
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			await this.refreshTools(conn).catch(() => {});
		});
		return client;
	}

	private async open(conn: Conn): Promise<void> {
		const cfg = conn.config;
		const connectWith = async (transport: Transport) => {
			const client = this.newClient(conn);
			conn.transport = transport;
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
			conn.client = client;
			const v = client.getServerVersion();
			conn.serverVersion = v ? `${v.name} ${v.version}` : undefined;
		};

		if (cfg.command) {
			const transport = new StdioClientTransport({
				command: cfg.command,
				args: cfg.args ?? [],
				env: cfg.env,
				cwd: cfg.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", (chunk: Buffer) => {
				for (const line of chunk.toString("utf-8").split(/\r?\n/)) {
					if (line.trim()) conn.stderr.push(line.slice(0, 500));
				}
				if (conn.stderr.length > 200) conn.stderr.splice(0, conn.stderr.length - 200);
			});
			await connectWith(transport);
			return;
		}

		const url = new URL(cfg.url!);
		const requestInit = cfg.headers ? { headers: cfg.headers } : undefined;
		const type = (cfg.type ?? "").toLowerCase();
		if (type === "sse") {
			await connectWith(new SSEClientTransport(url, { requestInit }));
			return;
		}
		try {
			await connectWith(new StreamableHTTPClientTransport(url, { requestInit }));
		} catch (err) {
			if (type === "http" || type === "streamable-http" || /401|unauthori[sz]ed/i.test(String(err))) throw err;
			// Servidores antiguos solo hablan SSE.
			await this.close(conn, true);
			await connectWith(new SSEClientTransport(url, { requestInit }));
		}
	}

	private async refreshTools(conn: Conn): Promise<void> {
		if (!conn.client) return;
		const tools: McpToolInfo[] = [];
		let cursor: string | undefined;
		const used = new Set<string>();
		do {
			const page = await conn.client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
			for (const t of page.tools) {
				let exposed = exposedToolName(conn.name, t.name);
				while (used.has(exposed)) exposed = exposedToolName(conn.name, `${t.name}_${used.size}`);
				used.add(exposed);
				tools.push({
					name: t.name,
					exposed,
					description: (t.description ?? t.title ?? t.name).trim(),
					inputSchema: cleanSchema(t.inputSchema),
					readOnly: t.annotations?.readOnlyHint === true,
				});
			}
			cursor = page.nextCursor;
		} while (cursor && tools.length < 500);
		conn.tools = tools;
	}

	private async close(conn: Conn, keepState = false): Promise<void> {
		conn.closing = true;
		const client = conn.client;
		const transport = conn.transport;
		conn.client = undefined;
		conn.transport = undefined;
		conn.tools = [];
		if (!keepState) {
			conn.state = "off";
			conn.error = undefined;
		}
		try {
			if (client) await client.close();
			else if (transport) await transport.close();
		} catch {
			// ya estaba cerrado
		}
	}
}

/** Texto legible del resultado de una tool MCP. */
function formatContent(r: { content?: unknown[]; structuredContent?: unknown; toolResult?: unknown }): string {
	const parts: string[] = [];
	for (const item of r.content ?? []) {
		const c = item as { type?: string; text?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri?: string; text?: string } };
		if (c.type === "text" && c.text) parts.push(c.text);
		else if (c.type === "image") parts.push(`[Imagen (${c.mimeType ?? "imagen"}): no se puede mostrar]`);
		else if (c.type === "audio") parts.push(`[Audio (${c.mimeType ?? "audio"}): no se puede reproducir]`);
		else if (c.type === "resource") parts.push(c.resource?.text ?? `[Recurso: ${c.resource?.uri ?? ""}]`);
		else if (c.type === "resource_link") parts.push(`[Enlace: ${c.name ?? ""} ${c.uri ?? ""}]`.trim());
	}
	if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
	if (!parts.length && r.toolResult !== undefined) parts.push(typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult, null, 2));
	return parts.join("\n\n");
}

export const mcpManager = new McpManager();
