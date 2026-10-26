import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { ToolResult } from "../agent/Types.js";
import { toolSchemas } from "./schemas.js";
import { getWorkspaceDir as getActiveWorkspaceDir } from "../../workspace.js";
import { registerToolExecutor, getToolExecutor, hasToolExecutor } from "./toolExecutors.js";

// Importar ejecutores de módulos separados
import { executeFetchUrl } from "./modules/fetch.js";
import { executeSearchWeb } from "./modules/search.js";
import { executeGetWeather } from "./modules/weather.js";
import { executeCalculator } from "./modules/calculator.js";
import { executeGetTime } from "./modules/time.js";
import {
	executePcClipboard,
	executePcKeyboard,
	executePcMedia,
	executePcMouse,
	executePcOpen,
	executePcPower,
	executePcProcesses,
	executePcScreenshot,
	executePcSystem,
	executePcWindows,
} from "./modules/pc.js";
import { executeUseSkill } from "./modules/skills.js";
import { executeBrowser, executeTerminal } from "./modules/workbench.js";
import { executeProject } from "./modules/project.js";
import { isWithinRoot } from "./paths.js";
import { isPotentiallyDangerousCommand } from "../sanitizeResponse.js";

// Registrar ejecutores
registerToolExecutor("pc_open", executePcOpen);
registerToolExecutor("pc_screenshot", executePcScreenshot);
registerToolExecutor("pc_keyboard", executePcKeyboard);
registerToolExecutor("pc_mouse", executePcMouse);
registerToolExecutor("pc_media", executePcMedia);
registerToolExecutor("pc_windows", executePcWindows);
registerToolExecutor("pc_processes", executePcProcesses);
registerToolExecutor("pc_clipboard", executePcClipboard);
registerToolExecutor("pc_system", executePcSystem);
registerToolExecutor("pc_power", executePcPower);
registerToolExecutor("browser", executeBrowser);
registerToolExecutor("terminal", executeTerminal);
registerToolExecutor("fetch_url", executeFetchUrl);
registerToolExecutor("search_web", executeSearchWeb);
registerToolExecutor("get_weather", executeGetWeather);
registerToolExecutor("calculator", executeCalculator);
registerToolExecutor("get_time", executeGetTime);
registerToolExecutor("use_skill", executeUseSkill);
registerToolExecutor("project", executeProject);

/** Raíz de read_file/write_file/list_dir: data/workspace, o la carpeta "Shiro" de la bóveda con Obsidian. */
export function getWorkspaceDir(): string {
	return getActiveWorkspaceDir();
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
	if (!isWithinRoot(full, workspaceReal, false)) return null;
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
	if (!isWithinRoot(full, rootReal, true)) return null;
	return full;
}

function validateArgs(name: string, args: Record<string, unknown>): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
	const schema = toolSchemas[name];
	if (!schema) return { ok: false, error: "Herramienta desconocida: " + name };
	const parsed = schema.safeParse(args);
	if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
	// Mensaje corto y claro para que el modelo pueda corregir la llamada.
	const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
	return { ok: false, error: `Argumentos inválidos para ${name}: ${problems}. Corrige los argumentos y vuelve a intentarlo.` };
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const hasSchema = Boolean(toolSchemas[name]);
	let validatedData: Record<string, unknown> | null = null;
	if (hasSchema) {
		const validated = validateArgs(name, args);
		if (!validated.ok) return { ok: false, error: validated.error };
		validatedData = validated.data;
	}

	// Primero verificar si hay un ejecutor registrado para esta tool
	if (hasToolExecutor(name)) {
		const executor = getToolExecutor(name)!;
		let result: Awaited<ReturnType<typeof executor>>;
		try {
			result = await executor(validatedData ?? args);
		} catch (err) {
			// Un fallo inesperado se le cuenta al modelo como error de la tool, sin cortar la respuesta entera.
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		if (result.ok) {
			return result.image ? { ok: true, content: result.content, image: result.image } : { ok: true, content: result.content };
		}
		return { ok: false, error: result.content };
	}

	// Fallback: ejecutores inline para tools no separadas aún
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
			case "describe_image": {
				const url = String(args_.url ?? "").trim();
				if (!url) return { ok: false, error: "URL de imagen requerida" };
				const isDataUri = url.startsWith("data:image/");
				const isHttpUrl = /^https?:\/\//i.test(url);
				if (!isDataUri && !isHttpUrl) {
					return { ok: false, error: "URL inválida. Debe ser data:image/... o https://..." };
				}
				if (isHttpUrl) {
					try {
						const parsed = new URL(url);
						if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
							return { ok: false, error: "Solo se permiten URLs http o https" };
						}
					} catch {
						return { ok: false, error: "URL inválida" };
					}
				}
				const MAX_IMAGE_URL_SIZE = 5 * 1024 * 1024;
				if (isHttpUrl) {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 10000);
					try {
						const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
						clearTimeout(timeoutId);
						if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
						const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
						if (!contentType.startsWith("image/")) {
							return { ok: false, error: "La URL no es una imagen (content-type: " + contentType + ")" };
						}
						const buf = await res.arrayBuffer();
						if (buf.byteLength > MAX_IMAGE_URL_SIZE) {
							return { ok: false, error: "Imagen demasiado grande (máx 5MB)" };
						}
						return { ok: true, content: `[Imagen descargada: ${contentType}, ${buf.byteLength} bytes. El modelo de visión debe analizar esta imagen.]` };
					} catch (e) {
						clearTimeout(timeoutId);
						if (e instanceof Error && e.name === "AbortError") {
							return { ok: false, error: "Timeout al descargar imagen" };
						}
						return { ok: false, error: e instanceof Error ? e.message : String(e) };
					}
				}
				return { ok: true, content: "[Imagen en data URI. El modelo de visión debe analizarla.]" };
			}
			case "exec": {
				const command = String(args_.command ?? "").trim();
				const timeout = args_.timeout ? Number(args_.timeout) : 30000;
				const workingDir = args_.workingDir ? String(args_.workingDir).trim() : undefined;
				
				if (!command) return { ok: false, error: "El comando es requerido" };
				if (command.length > 1000) return { ok: false, error: "Comando demasiado largo" };
				
				if (isPotentiallyDangerousCommand(command)) {
					return { ok: false, error: "El comando contiene caracteres no permitidos" };
				}
				
				const { exec } = await import("node:child_process");
				
				return new Promise((resolve) => {
					const opts: { timeout: number; cwd?: string } = { timeout };
					if (workingDir) opts.cwd = workingDir;
					
					exec(command, opts, (error, stdout, stderr) => {
						if (error) {
							resolve({ 
								ok: false, 
								error: `Error: ${error.message}${stderr ? "\nstderr: " + stderr : ""}` 
							});
							return;
						}
						const output = stdout || "(sin salida)";
						const errOutput = stderr ? "\n⚠️ stderr: " + stderr : "";
						resolve({ ok: true, content: output + errOutput });
					});
				});
			}
			case "calculator": {
				const expression = String(args_.expression ?? "").trim();
				if (!expression) return { ok: false, error: "Expresión requerida" };
				if (expression.length > 500) return { ok: false, error: "Expresión demasiado larga" };
				const dangerous = /[;|`$(){}\[\]\\]/;
				if (dangerous.test(expression)) {
					return { ok: false, error: "Expresión contiene caracteres no permitidos" };
				}
				try {
					const sanitized = expression
						.replace(/sqrt\(/gi, "Math.sqrt(")
						.replace(/pow\(/gi, "Math.pow(")
						.replace(/abs\(/gi, "Math.abs(")
						.replace(/floor\(/gi, "Math.floor(")
						.replace(/ceil\(/gi, "Math.ceil(")
						.replace(/round\(/gi, "Math.round(")
						.replace(/log\(/gi, "Math.log(")
						.replace(/exp\(/gi, "Math.exp(")
						.replace(/PI/gi, "Math.PI")
						.replace(/E/gi, "Math.E");
					const result = Function(`"use strict"; return (${sanitized})`)();
					if (typeof result !== "number") {
						return { ok: false, error: "El resultado no es un número" };
					}
					if (!isFinite(result)) {
						return { ok: false, error: "El resultado es infinito o indefinido" };
					}
					return { ok: true, content: String(result) };
				} catch {
					return { ok: false, error: "Expresión matemática inválida" };
				}
			}
			case "get_time": {
				const timezone = args_.timezone ? String(args_.timezone).trim() : undefined;
				let date: Date;
				try {
					date = timezone ? new Date(new Date().toLocaleString("en-US", { timeZone: timezone })) : new Date();
				} catch {
					return { ok: false, error: "Zona horaria inválida" };
				}
				const format = (d: Date) => {
					const iso = d.toISOString();
					const local = d.toLocaleString("es-ES", { timeZone: timezone });
					const utc = d.toUTCString();
					return `Fecha: ${local}\nUTC: ${utc}\nISO: ${iso}`;
				};
				return { ok: true, content: format(date) };
			}
			case "create_reminder": {
				const { createReminder } = await import("../reminders/reminders.js");
				const title = String(args_.title ?? "").trim();
				const datetime = String(args_.datetime ?? "").trim();
				const description = args_.description ? String(args_.description).trim() : undefined;
				const repeat = args_.repeat ? String(args_.repeat).trim() as "daily" | "weekly" | "monthly" | "none" : "none";
				
				if (!title) return { ok: false, error: "El título es requerido" };
				if (!datetime) return { ok: false, error: "La fecha y hora es requerida" };
				
				const validRepeat = ["daily", "weekly", "monthly", "none"].includes(repeat) ? repeat : "none";
				
				try {
					const reminder = await createReminder({ title, datetime, description, repeat: validRepeat });
					const date = new Date(reminder.datetime);
					const formatted = date.toLocaleString("es-ES");
					const repeatText = validRepeat === "none" ? "" : ` (se repite ${validRepeat})`;
					return { ok: true, content: `✅ Recordatorio creado: "${reminder.title}" para el ${formatted}${repeatText}\nID: ${reminder.id}` };
				} catch (err) {
					return { ok: false, error: "Error al crear recordatorio: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "list_reminders": {
				const { getReminders, getActiveReminders } = await import("../reminders/reminders.js");
				const includeCompleted = args_.include_completed === true;
				
				const reminders = includeCompleted ? await getReminders() : await getActiveReminders();
				
				if (reminders.length === 0) {
					return { ok: true, content: "No tienes recordatorios." };
				}
				
				let output = "📋 Tus recordatorios:\n\n";
				
				for (const r of reminders.slice(0, 20)) {
					const date = new Date(r.datetime);
					const formatted = date.toLocaleString("es-ES");
					const status = r.completed ? "✅" : r.active ? "⏰" : "❌";
					const repeat = r.repeat && r.repeat !== "none" ? ` (${r.repeat})` : "";
					output += `${status} ${r.title}\n   📅 ${formatted}${repeat}\n   ID: ${r.id}\n\n`;
				}
				
				return { ok: true, content: output };
			}
			case "complete_reminder": {
				const { completeReminder, getReminderById } = await import("../reminders/reminders.js");
				const id = String(args_.id ?? "").trim();
				
				if (!id) return { ok: false, error: "El ID del recordatorio es requerido" };
				
				const existing = await getReminderById(id);
				if (!existing) return { ok: false, error: "Recordatorio no encontrado" };
				
				try {
					const result = await completeReminder(id);
					if (result) {
						return { ok: true, content: `✅ Recordatorio completado: "${existing.title}"` + (result.repeat && result.repeat !== "none" ? " (próximo creado para mañana)" : "") };
					}
					return { ok: false, error: "No se pudo completar el recordatorio" };
				} catch (err) {
					return { ok: false, error: "Error al completar: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "get_weather": {
				const city = String(args_.city ?? "").trim();
				if (!city) return { ok: false, error: "El nombre de la ciudad es requerido" };
				
				const WEATHER_API = "https://wttr.in/" + encodeURIComponent(city) + "?format=%c%t+%h+%p+%w&lang=es";
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);
				
				try {
					const res = await fetch(WEATHER_API, { signal: controller.signal });
					clearTimeout(timeoutId);
					if (!res.ok) return { ok: false, error: `Error al obtener clima: ${res.status}` };
					
					const text = await res.text();
					const lines = text.trim().split("\n");
					
					let temp = "", humidity = "", precip = "", wind = "";
					for (const line of lines) {
						if (line.includes("°C") || line.includes("°F")) temp = line.trim();
						else if (line.includes("%")) humidity = line.trim();
						else if (line.includes("mm") || line.includes("cm")) precip = line.trim();
						else if (line.includes("km/h") || line.includes("mph")) wind = line.trim();
					}
					
					let result = `🌤️ Clima en ${city}:\n`;
					if (temp) result += `   Temperatura: ${temp}\n`;
					if (humidity) result += `   Humedad: ${humidity}\n`;
					if (precip) result += `   Precipitación: ${precip}\n`;
					if (wind) result += `   Viento: ${wind}\n`;
					
					result += "\n   Fuente: wttr.in";
					
					return { ok: true, content: result };
				} catch (err) {
					clearTimeout(timeoutId);
					if (err instanceof Error && err.name === "AbortError") {
						return { ok: false, error: "Timeout al obtener clima" };
					}
					return { ok: false, error: "No se pudo obtener el clima: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "memory_search": {
				const { searchMemories } = await import("../memory/memories.js");
				const query = String(args_.query ?? "").trim();
				const limit = args_.limit ? Math.min(20, Math.max(1, Number(args_.limit))) : 5;
				if (!query) return { ok: false, error: "La query de búsqueda es requerida" };
				const results = await searchMemories(query, limit);
				if (results.length === 0) return { ok: true, content: "No encontré recuerdos relacionados." };
				const lines = results.map((r) => {
					const when = r.createdAt ? ` (${new Date(r.createdAt).toLocaleString("es-ES")})` : "";
					const from = r.source ? `\n   📄 ${r.source}` : "";
					return `📝 ${r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content}${when}${from}`;
				});
				return { ok: true, content: "🔍 Resultados de memoria:\n\n" + lines.join("\n\n") };
			}
			case "memory_add": {
				const { addMemory } = await import("../memory/memories.js");
				const content = String(args_.content ?? "").trim();
				if (!content) return { ok: false, error: "El contenido es requerido" };
				const tags = Array.isArray(args_.tags) ? (args_.tags as unknown[]).map(String) : undefined;
				const important = args_.important === true;
				const memory = await addMemory({ content, type: args_.type ? String(args_.type) : undefined, tags, important });
				const { currentStorage, STORAGE_LABELS } = await import("../../storage/storage.js");
				return {
					ok: true,
					content: `✅ Recuerdo guardado en ${STORAGE_LABELS[currentStorage().kind]}${important ? " y apuntado en MEMORY.md" : ""} (ID: ${memory.id})`,
				};
			}
			case "sessions_list": {
				const { listChatSessions } = await import("../../chat/ChatStore.js");
				const sessions = await listChatSessions();
				if (sessions.length === 0) return { ok: true, content: "No hay chats guardados." };
				let output = "📋 Chats (los 10 más recientes):\n\n";
				for (const s of sessions.slice(0, 10)) {
					output += `🆔 ${s.id}\n   Título: ${s.title}\n   Actualizado: ${new Date(s.updatedAt).toLocaleString("es-ES")}\n\n`;
				}
				return { ok: true, content: output };
			}
			case "sessions_history": {
				const { getChatSession, listChatSessions } = await import("../../chat/ChatStore.js");
				const { getMessagePreview } = await import("../agent/contentUtils.js");
				const sessionIdRaw = args_.sessionId ?? args_.session_id;
				const limit = args_.limit ? Math.max(1, Number(args_.limit)) : 20;
				const sessionId = sessionIdRaw ? String(sessionIdRaw).trim() : (await listChatSessions())[0]?.id;
				if (!sessionId) return { ok: true, content: "No hay chats guardados." };
				const session = await getChatSession(sessionId);
				if (!session) return { ok: false, error: `No existe el chat ${sessionId}` };
				if (session.messages.length === 0) return { ok: true, content: "Ese chat no tiene mensajes." };
				let output = `📖 ${session.title} (${session.id}):\n\n`;
				for (const msg of session.messages.slice(-limit)) {
					const text = getMessagePreview(msg.content);
					output += `${msg.role === "user" ? "👤" : "🤖"} ${text.length > 300 ? text.slice(0, 300) + "…" : text}\n`;
				}
				return { ok: true, content: output };
			}
			case "cron_create": {
				const { createCronTask } = await import("../scheduler/CronService.js");
				const name = String(args_.name ?? "").trim();
				const expression = String(args_.expression ?? "").trim();
				const action = String(args_.action ?? "notify") as "notify" | "exec" | "reminder";
				const message = args_.message ? String(args_.message) : undefined;
				const command = args_.command ? String(args_.command) : undefined;
				
				if (!name) return { ok: false, error: "El nombre es requerido" };
				if (!expression) return { ok: false, error: "La expresión es requerida" };
				
				const payload: Record<string, unknown> = {};
				if (message) payload.message = message;
				if (command) payload.command = command;
				
				try {
					const task = createCronTask(name, expression, action, payload);
					return { ok: true, content: `✅ Tarea programada creada: "${task.name}" (ID: ${task.id})\n   Frecuencia: ${task.expression}\n   Acción: ${task.action}` };
				} catch (err) {
					return { ok: false, error: "Error al crear tarea: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "cron_list": {
				const { listCronTasks } = await import("../scheduler/CronService.js");
				const tasks = listCronTasks();
				
				if (tasks.length === 0) {
					return { ok: true, content: "No hay tareas programadas." };
				}
				
				let output = "📅 Tareas Programadas:\n\n";
				for (const t of tasks) {
					const status = t.enabled ? "✅" : "⏸️";
					const lastRun = t.lastRun ? new Date(t.lastRun).toLocaleString() : "nunca";
					output += `${status} ${t.name}\n`;
					output += `   📋 ID: ${t.id}\n`;
					output += `   ⏰ Frecuencia: ${t.expression}\n`;
					output += `   🔧 Acción: ${t.action}\n`;
					output += `   🕐 Último: ${lastRun}\n\n`;
				}
				
				return { ok: true, content: output };
			}
			case "cron_delete": {
				const { deleteCronTask } = await import("../scheduler/CronService.js");
				const id = String(args_.id ?? "").trim();
				
				if (!id) return { ok: false, error: "El ID es requerido" };
				
				const deleted = deleteCronTask(id);
				if (deleted) {
					return { ok: true, content: `✅ Tarea eliminada: ${id}` };
				}
				return { ok: false, error: "Tarea no encontrada" };
			}
			case "cron_toggle": {
				const { toggleCronTask } = await import("../scheduler/CronService.js");
				const id = String(args_.id ?? "").trim();
				const enabled = args_.enabled === true;
				
				if (!id) return { ok: false, error: "El ID es requerido" };
				
				const task = toggleCronTask(id, enabled);
				if (task) {
					const status = task.enabled ? "activada" : "desactivada";
					return { ok: true, content: `✅ Tarea ${status}: ${task.name}` };
				}
				return { ok: false, error: "Tarea no encontrada" };
			}
			case "git": {
				const command = args_.command ? String(args_.command).trim() : "";
				const repoPath = args_.repoPath ? String(args_.repoPath).trim() : ".";
				
				if (!command) return { ok: false, error: "El comando git es requerido" };
				
				const { exec } = await import("node:child_process");
				const { resolve } = await import("node:path");
				
				const workspace = getWorkspaceDir();
				const cwd = resolve(workspace, repoPath);
				
				return new Promise((resolve) => {
					exec("git " + command, { cwd, timeout: 30000 }, (error, stdout, stderr) => {
						if (error) {
							resolve({ 
								ok: false, 
								error: `Git error: ${error.message}${stderr ? "\n" + stderr : ""}` 
							});
							return;
						}
						resolve({ 
							ok: true, 
							content: stdout || "(sin salida)" + (stderr ? "\n⚠️ " + stderr : "") 
						});
					});
				});
			}
			case "ask_user": {
				const question = args_.question ? String(args_.question).trim() : "";
				
				if (!question) return { ok: false, error: "La pregunta es requerida" };
				
				return { 
					ok: true, 
					content: `🤔 PREGUNTA: ${question}\n\n(Responde a esta pregunta para que pueda ayudarte mejor)` 
				};
			}
			default:
				return { ok: false, error: "Herramienta desconocida: " + name };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
