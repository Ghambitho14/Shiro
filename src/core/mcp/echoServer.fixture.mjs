// Servidor MCP mínimo para las pruebas de McpManager (mcp.test.ts). No lo usa Shiro.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "eco", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Devuelve el texto",
			inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			annotations: { readOnlyHint: true },
		},
		{ name: "falla", description: "Siempre falla", inputSchema: { type: "object", properties: {} } },
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "echo") return { content: [{ type: "text", text: String(req.params.arguments?.text ?? "") }] };
	return { content: [{ type: "text", text: "algo salió mal" }], isError: true };
});

console.error("eco listo");
await server.connect(new StdioServerTransport());
