import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { WORKSPACE_DIR } from "./workspace.js";

const MAX_FILE_SIZE = 512 * 1024; // 512 KB

/** Raíz para acceso al sistema (PC). Por defecto: USERPROFILE (Windows) o HOME (Linux/Mac). Override: PICLAW_SYSTEM_ROOT. */
function getSystemRoot(): string {
	const envRoot = process.env.PICLAW_SYSTEM_ROOT?.trim();
	if (envRoot) return resolve(envRoot);
	const home = process.env.USERPROFILE || process.env.HOME;
	if (home) return resolve(home);
	return resolve(process.cwd());
}

/** Resuelve path relativo al workspace. Devuelve null si escapa del workspace. */
function resolveWorkspacePath(relativePath: string): string | null {
	const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
	const full = resolve(WORKSPACE_DIR, normalized);
	const workspaceReal = resolve(WORKSPACE_DIR);
	if (!full.startsWith(workspaceReal) || full === workspaceReal) return null;
	return full;
}

/** Resuelve path para acceso sistema (bajo la raíz de PC). Acepta ruta absoluta o relativa a la raíz. Devuelve null si escapa. */
function resolveSystemPath(pathArg: string): string | null {
	const root = getSystemRoot();
	const normalized = pathArg.replace(/\\/g, "/").trim();
	const full = normalized && (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
		? resolve(normalized)
		: resolve(root, normalized || ".");
	const rootReal = resolve(root);
	// Debe estar dentro de la raíz (o ser la raíz para list_dir)
	if (full !== rootReal && !full.startsWith(rootReal + "/") && !full.startsWith(rootReal + "\\")) return null;
	return full;
}

export type ToolResult = { ok: true; content: string } | { ok: false; error: string };

export function executeTool(name: string, args: Record<string, unknown>): ToolResult {
	try {
		switch (name) {
			case "read_file": {
				const pathArg = args.path;
				if (typeof pathArg !== "string" || !pathArg.trim()) {
					return { ok: false, error: "read_file requiere path (string)." };
				}
				const filePath = resolveWorkspacePath(pathArg.trim());
				if (!filePath) return { ok: false, error: "Path fuera del workspace." };
				if (!existsSync(filePath)) return { ok: false, error: "Archivo no encontrado." };
				const stat = statSync(filePath);
				if (!stat.isFile()) return { ok: false, error: "No es un archivo." };
				if (stat.size > MAX_FILE_SIZE) return { ok: false, error: "Archivo demasiado grande (máx 512 KB)." };
				const content = readFileSync(filePath, "utf-8");
				return { ok: true, content };
			}
			case "write_file": {
				const pathArg = args.path;
				const contentArg = args.content;
				if (typeof pathArg !== "string" || !pathArg.trim()) {
					return { ok: false, error: "write_file requiere path (string)." };
				}
				const content = contentArg !== undefined ? String(contentArg) : "";
				const filePath = resolveWorkspacePath(pathArg.trim());
				if (!filePath) return { ok: false, error: "Path fuera del workspace." };
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf-8");
				return { ok: true, content: "Escrito correctamente." };
			}
			case "list_dir": {
				const pathArg = args.path;
				const dirPath = pathArg && typeof pathArg === "string" && pathArg.trim()
					? resolveWorkspacePath(pathArg.trim())
					: resolve(WORKSPACE_DIR);
				if (!dirPath || !existsSync(dirPath)) return { ok: false, error: "Directorio no encontrado." };
				const st = statSync(dirPath);
				if (!st.isDirectory()) return { ok: false, error: "No es un directorio." };
				const entries = readdirSync(dirPath, { withFileTypes: true });
				const names = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
				return { ok: true, content: names.join("\n") };
			}
			case "read_file_system": {
				const pathArg = args.path;
				if (typeof pathArg !== "string" || !pathArg.trim()) {
					return { ok: false, error: "read_file_system requiere path (string)." };
				}
				const filePath = resolveSystemPath(pathArg.trim());
				if (!filePath) return { ok: false, error: "Path fuera del ámbito permitido (raíz: " + getSystemRoot() + ")." };
				if (!existsSync(filePath)) return { ok: false, error: "Archivo no encontrado." };
				const stat = statSync(filePath);
				if (!stat.isFile()) return { ok: false, error: "No es un archivo." };
				if (stat.size > MAX_FILE_SIZE) return { ok: false, error: "Archivo demasiado grande (máx 512 KB)." };
				const content = readFileSync(filePath, "utf-8");
				return { ok: true, content };
			}
			case "write_file_system": {
				const pathArg = args.path;
				const contentArg = args.content;
				if (typeof pathArg !== "string" || !pathArg.trim()) {
					return { ok: false, error: "write_file_system requiere path (string)." };
				}
				const content = contentArg !== undefined ? String(contentArg) : "";
				const filePath = resolveSystemPath(pathArg.trim());
				if (!filePath) return { ok: false, error: "Path fuera del ámbito permitido." };
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf-8");
				return { ok: true, content: "Escrito correctamente." };
			}
			case "list_dir_system": {
				const pathArg = args.path;
				const root = getSystemRoot();
				const dirPath = pathArg && typeof pathArg === "string" && pathArg.trim()
					? resolveSystemPath(pathArg.trim())
					: root;
				if (!dirPath || !existsSync(dirPath)) return { ok: false, error: "Directorio no encontrado." };
				const st = statSync(dirPath);
				if (!st.isDirectory()) return { ok: false, error: "No es un directorio." };
				const entries = readdirSync(dirPath, { withFileTypes: true });
				const names = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
				return { ok: true, content: names.join("\n") };
			}
			default:
				return { ok: false, error: "Herramienta desconocida: " + name };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

type ToolDef = {
	type: "function";
	function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
};

/** Definición de tools en formato OpenAI para vLLM. */
export function getToolsDefinition(): ToolDef[] {
	return [
		{
			type: "function",
			function: {
				name: "read_file",
				description: "Lee el contenido de un archivo del workspace. Path relativo (ej: SOUL.md, memory/2025-02-24.md).",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Ruta relativa al workspace" } },
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write_file",
				description: "Escribe o sobrescribe un archivo en el workspace. Usa para actualizar MEMORY.md, memory/YYYY-MM-DD.md, etc.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Ruta relativa al workspace" },
						content: { type: "string", description: "Contenido a escribir" },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "list_dir",
				description: "Lista archivos y carpetas en el workspace (o en una subcarpeta). Sin argumentos lista la raíz del workspace.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Ruta relativa (opcional, ej: memory)" } },
				},
			},
		},
		{
			type: "function",
			function: {
				name: "read_file_system",
				description: "Lee un archivo en la PC (acceso total bajo la carpeta del usuario). Ruta absoluta o relativa a la raíz (ej: C:\\Users\\tu\\Documents\\file.txt o Documents\\file.txt).",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Ruta al archivo" } },
					required: ["path"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "write_file_system",
				description: "Escribe un archivo en la PC (acceso total bajo la carpeta del usuario). Ruta absoluta o relativa.",
				parameters: {
					type: "object",
					properties: {
						path: { type: "string", description: "Ruta al archivo" },
						content: { type: "string", description: "Contenido a escribir" },
					},
					required: ["path", "content"],
				},
			},
		},
		{
			type: "function",
			function: {
				name: "list_dir_system",
				description: "Lista archivos y carpetas en la PC. Sin argumentos lista la raíz (carpeta de usuario). Con path lista esa carpeta (ej: Desktop, Documents).",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Ruta (opcional)" } },
				},
			},
		},
	];
}
