#!/usr/bin/env node
/**
 * Lanzador del servidor MCP de Shiro. Funciona desde cualquier carpeta
 * (OpenCode lo ejecuta desde el proyecto en el que estés trabajando):
 *
 *   node /ruta/a/Shiro/bin/shiro-mcp.mjs
 */
import { register } from "tsx/esm/api";

// stdout es del protocolo MCP: los logs van a stderr.
console.log = console.error;
console.info = console.error;

register();
const { runMcpServer } = await import("../src/mcp/server.ts");
await runMcpServer();
