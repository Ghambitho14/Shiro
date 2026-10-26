/**
 * Servidor MCP de Shiro (`npm run mcp`).
 *
 * Expone la memoria, recordatorios y búsqueda web de Shiro a cualquier agente
 * compatible con MCP (OpenCode, Claude Code, Cursor...). Así el agente de código
 * y Shiro comparten lo que Shiro sabe de ti.
 *
 * Importante: en MCP por stdio, stdout es solo para el protocolo; los logs van a stderr.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { APP_VERSION } from "../runtime.js";
import { executeToolSafeScoped, getToolsDefinitionScoped } from "../core/tools/ToolRegistry.js";

/**
 * Tools que se comparten. No se exponen archivos ni comandos: el agente de código
 * ya tiene los suyos, con sus propios permisos.
 */
export const MCP_TOOLS = [
	"memory_search",
	"memory_add",
	"create_reminder",
	"list_reminders",
	"complete_reminder",
	"search_web",
	"fetch_url",
	"get_weather",
	"sessions_list",
	"sessions_history",
];

export async function runMcpServer(): Promise<void> {
	const server = new Server({ name: "shiro", version: APP_VERSION }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: getToolsDefinitionScoped(MCP_TOOLS).map((t) => ({
			name: t.function.name,
			description: t.function.description ?? "",
			inputSchema: t.function.parameters ?? { type: "object" as const, properties: {} },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		const r = await executeToolSafeScoped(name, (args ?? {}) as Record<string, unknown>, MCP_TOOLS);
		return r.ok
			? { content: [{ type: "text" as const, text: r.content }] }
			: { content: [{ type: "text" as const, text: r.error }], isError: true };
	});

	await server.connect(new StdioServerTransport());
	console.error(`Shiro MCP listo (${MCP_TOOLS.length} herramientas)`);
}
