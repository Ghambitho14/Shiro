/** Re-export para compatibilidad. Usar core/tools en código nuevo. */
export { executeTool, getWorkspaceDir } from "./core/tools/tools.js";
export { getToolsDefinition, executeToolSafe } from "./core/tools/ToolRegistry.js";
export type { ToolResult } from "./core/agent/Types.js";
