import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { ToolResult } from "../agent/Types.js";
import { toolSchemas } from "./schemas.js";
import { DATA_DIR } from "../../config/config.js";

export function getWorkspaceDir(): string {
	return join(DATA_DIR, "workspace");
}

function getSystemRoot(): string {
	const envRoot = process.env.PICLAW_SYSTEM_ROOT?.trim();
	if (envRoot) return resolve(envRoot);
	const home = process.env.USERPROFILE || process.env.HOME;
	if (home) return resolve(home);
	return resolve(process.cwd());
}

const MAX_FILE_SIZE = 512 * 1024;

function resolveWorkspacePath(relativePath: string): string | null {
	const workspace = getWorkspaceDir();
	const normalized = relativePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");
	const full = resolve(workspace, normalized);
	const workspaceReal = resolve(workspace);
	if (!full.startsWith(workspaceReal) || full === workspaceReal) return null;
	return full;
}

function resolveSystemPath(pathArg: string): string | null {
	const root = getSystemRoot();
	const normalized = pathArg.replace(/\\/g, "/").trim();
	const full =
		normalized && (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
			? resolve(normalized)
			: resolve(root, normalized || ".");
	const rootReal = resolve(root);
	if (full !== rootReal && !full.startsWith(rootReal + "/") && !full.startsWith(rootReal + "\\")) return null;
	return full;
}

function validateArgs(name: string, args: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
	const schema = toolSchemas[name];
	if (!schema) return { ok: false, error: "Herramienta desconocida: " + name };
	try {
		const data = schema.parse(args) as Record<string, unknown>;
		return { ok: true, data };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

export function executeTool(name: string, args: Record<string, unknown>): ToolResult {
	const validated = validateArgs(name, args);
	if (!validated.ok) return { ok: false, error: validated.error };
	const args_ = validated.data;

	try {
		switch (name) {
			case "read_file": {
				const pathArg = String(args_.path ?? "").trim();
				const filePath = resolveWorkspacePath(pathArg);
				if (!filePath) return { ok: false, error: "Path fuera del workspace." };
				if (!existsSync(filePath)) return { ok: false, error: "Archivo no encontrado." };
				const stat = statSync(filePath);
				if (!stat.isFile()) return { ok: false, error: "No es un archivo." };
				if (stat.size > MAX_FILE_SIZE) return { ok: false, error: "Archivo demasiado grande (máx 512 KB)." };
				return { ok: true, content: readFileSync(filePath, "utf-8") };
			}
			case "write_file": {
				const pathArg = String(args_.path ?? "").trim();
				const content = args_.content !== undefined ? String(args_.content) : "";
				const filePath = resolveWorkspacePath(pathArg);
				if (!filePath) return { ok: false, error: "Path fuera del workspace." };
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf-8");
				return { ok: true, content: "Escrito correctamente." };
			}
			case "list_dir": {
				const pathArg = String(args_.path ?? "").trim();
				const workspace = getWorkspaceDir();
				const dirPath = pathArg ? resolveWorkspacePath(pathArg) : workspace;
				if (!dirPath || !existsSync(dirPath)) return { ok: false, error: "Directorio no encontrado." };
				const st = statSync(dirPath);
				if (!st.isDirectory()) return { ok: false, error: "No es un directorio." };
				const entries = readdirSync(dirPath, { withFileTypes: true });
				return { ok: true, content: entries.map((e: { isDirectory: () => boolean; name: string }) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") };
			}
			case "read_file_system": {
				const pathArg = String(args_.path ?? "").trim();
				const filePath = resolveSystemPath(pathArg);
				if (!filePath) return { ok: false, error: "Path fuera del ámbito permitido (raíz: " + getSystemRoot() + ")." };
				if (!existsSync(filePath)) return { ok: false, error: "Archivo no encontrado." };
				const stat = statSync(filePath);
				if (!stat.isFile()) return { ok: false, error: "No es un archivo." };
				if (stat.size > MAX_FILE_SIZE) return { ok: false, error: "Archivo demasiado grande (máx 512 KB)." };
				return { ok: true, content: readFileSync(filePath, "utf-8") };
			}
			case "write_file_system": {
				const pathArg = String(args_.path ?? "").trim();
				const content = args_.content !== undefined ? String(args_.content) : "";
				const filePath = resolveSystemPath(pathArg);
				if (!filePath) return { ok: false, error: "Path fuera del ámbito permitido." };
				mkdirSync(dirname(filePath), { recursive: true });
				writeFileSync(filePath, content, "utf-8");
				return { ok: true, content: "Escrito correctamente." };
			}
			case "list_dir_system": {
				const pathArg = String(args_.path ?? "").trim();
				const root = getSystemRoot();
				const dirPath = pathArg ? resolveSystemPath(pathArg) : root;
				if (!dirPath || !existsSync(dirPath)) return { ok: false, error: "Directorio no encontrado." };
				const st = statSync(dirPath);
				if (!st.isDirectory()) return { ok: false, error: "No es un directorio." };
				const entries = readdirSync(dirPath, { withFileTypes: true });
				return { ok: true, content: entries.map((e: { isDirectory: () => boolean; name: string }) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") };
			}
			default:
				return { ok: false, error: "Herramienta desconocida: " + name };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
