import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { ToolResult } from "../agent/Types.js";
import { toolSchemas } from "./schemas.js";
import { DATA_DIR } from "../../config/config.js";
import { registerToolExecutor, getToolExecutor, hasToolExecutor } from "./toolExecutors.js";

// Importar ejecutores de módulos separados
import { executeFetchUrl, executeHttpRequest } from "./modules/fetch.js";
import { executeSearchWeb } from "./modules/search.js";
import { executeGetWeather } from "./modules/weather.js";
import { executeCalculator } from "./modules/calculator.js";
import { executeGetTime } from "./modules/time.js";
import { executePython } from "./modules/python.js";
import { isPotentiallyDangerousCommand } from "../sanitizeResponse.js";

// Registrar ejecutores
registerToolExecutor("fetch_url", executeFetchUrl);
registerToolExecutor("http_request", executeHttpRequest);
registerToolExecutor("search_web", executeSearchWeb);
registerToolExecutor("get_weather", executeGetWeather);
registerToolExecutor("calculator", executeCalculator);
registerToolExecutor("get_time", executeGetTime);
registerToolExecutor("execute_python", executePython);

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

function normalizeForCompare(pathValue: string): string {
	const resolved = resolve(pathValue);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithinRoot(pathValue: string, rootValue: string, allowRoot = false): boolean {
	const pathNormalized = normalizeForCompare(pathValue);
	const rootNormalized = normalizeForCompare(rootValue);
	if (allowRoot && pathNormalized === rootNormalized) return true;
	if (pathNormalized === rootNormalized) return false;
	const sep = process.platform === "win32" ? "\\" : "/";
	const boundaryRoot = rootNormalized.endsWith(sep) ? rootNormalized : rootNormalized + sep;
	return pathNormalized.startsWith(boundaryRoot);
}

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
	try {
		const data = schema.parse(args) as Record<string, unknown>;
		return { ok: true, data };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
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
		const result = await executor(validatedData ?? args);
		if (result.ok) {
			return { ok: true, content: result.content };
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
					const reminder = createReminder({ title, datetime, description, repeat: validRepeat });
					const date = new Date(reminder.datetime);
					const formatted = date.toLocaleString("es-ES");
					const repeatText = validRepeat === "none" ? "" : ` (se repite ${validRepeat})`;
					return { ok: true, content: `✅ Recordatorio creado: "${reminder.title}" para el ${formatted}${repeatText}\nID: ${reminder.id}` };
				} catch (err) {
					return { ok: false, error: "Error al crear recordatorio: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "list_reminders": {
				const { getReminders, getActiveReminders, getUpcomingReminders } = await import("../reminders/reminders.js");
				const includeCompleted = args_.include_completed === true;
				
				const reminders = includeCompleted ? getReminders() : getActiveReminders();
				
				if (reminders.length === 0) {
					return { ok: true, content: "No tienes recordatorios." };
				}
				
				const upcoming = getUpcomingReminders(5);
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
				
				const existing = getReminderById(id);
				if (!existing) return { ok: false, error: "Recordatorio no encontrado" };
				
				try {
					const result = completeReminder(id);
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
				const { VectorMemoryStore } = await import("../memory/VectorMemoryStore.js");
				const { getEmbeddingsProvider } = await import("../memory/EmbeddingsClient.js");
				const query = String(args_.query ?? "").trim();
				const limit = args_.limit ? Number(args_.limit) : 5;
				
				if (!query) return { ok: false, error: "La query de búsqueda es requerida" };
				
				const store = new VectorMemoryStore(getEmbeddingsProvider());
				const results = await store.search(query, limit);
				
				if (results.length === 0) {
					return { ok: true, content: "No se encontraron recuerdos relacionados." };
				}
				
				let output = "🔍 Resultados de memoria:\n\n";
				for (const r of results) {
					output += `📝 ${r.content.slice(0, 200)}...\n`;
					output += `   🕐 ${new Date(r.metadata.timestamp).toLocaleString()}\n\n`;
				}
				
				return { ok: true, content: output };
			}
			case "memory_add": {
				const { VectorMemoryStore } = await import("../memory/VectorMemoryStore.js");
				const { getEmbeddingsProvider } = await import("../memory/EmbeddingsClient.js");
				const content = String(args_.content ?? "").trim();
				const type = args_.type ? String(args_.type) : "conversation";
				const tags = args_.tags ? args_.tags as string[] : undefined;
				
				if (!content) return { ok: false, error: "El contenido es requerido" };
				
				const store = new VectorMemoryStore(getEmbeddingsProvider());
				const id = await store.add({
					content,
					metadata: {
						timestamp: new Date().toISOString(),
						type: type as "conversation" | "tool_call" | "observation" | "decision",
						tags,
					},
				});
				
				return { ok: true, content: `✅ Recuerdo guardado con ID: ${id}` };
			}
			case "sessions_list": {
				const { SessionTranscripts } = await import("../memory/SessionTranscripts.js");
				const transcripts = new SessionTranscripts();
				const sessions = transcripts.list();
				
				if (sessions.length === 0) {
					return { ok: true, content: "No hay sesiones guardadas." };
				}
				
				let output = "📋 Sesiones:\n\n";
				for (const s of sessions.slice(0, 10)) {
					output += `🆔 ${s.id}\n`;
					output += `   Nombre: ${s.name}\n`;
					output += `   Mensajes: ${s.messages.length}\n`;
					output += `   Actualizado: ${new Date(s.updatedAt).toLocaleString()}\n\n`;
				}
				
				return { ok: true, content: output };
			}
			case "sessions_history": {
				const { SessionTranscripts } = await import("../memory/SessionTranscripts.js");
				const sessionIdRaw = args_.sessionId ?? args_.session_id;
				const sessionId = sessionIdRaw ? String(sessionIdRaw).trim() : undefined;
				const limit = args_.limit ? Number(args_.limit) : 20;
				
				const transcripts = new SessionTranscripts();
				
				if (sessionId) {
					const history = transcripts.getHistory(sessionId, limit);
					if (history.length === 0) {
						return { ok: true, content: "No hay mensajes en esta sesión." };
					}
					
					let output = `📖 Historial de sesión ${sessionId}:\n\n`;
					for (const msg of history) {
						const role = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "⚙️";
						output += `${role} ${msg.role}: ${msg.content.slice(0, 100)}...\n`;
					}
					
					return { ok: true, content: output };
				}
				
				// Listar todas las sesiones
				const sessions = transcripts.list();
				if (sessions.length === 0) {
					return { ok: true, content: "No hay sesiones." };
				}
				
				// Mostrar última sesión
				const lastSession = sessions[0];
				const history = transcripts.getHistory(lastSession.id, limit);
				
				let output = `📖 Última sesión (${lastSession.id}):\n\n`;
				for (const msg of history) {
					const role = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "⚙️";
					output += `${role} ${msg.role}: ${msg.content.slice(0, 80)}...\n`;
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
			case "project_analyze": {
				const pathArg = args_.path ? String(args_.path).trim() : ".";
				const deep = args_.deep === true;
				
				const { readFileSync, readdirSync, statSync, existsSync } = await import("node:fs");
				const { resolve, join } = await import("node:path");
				
				const workspace = getWorkspaceDir();
				const projectPath = resolve(workspace, pathArg);
				
				if (!existsSync(projectPath)) {
					return { ok: false, error: "El path no existe: " + projectPath };
				}
				
				const stat = statSync(projectPath);
				if (!stat.isDirectory()) {
					return { ok: false, error: "No es un directorio" };
				}
				
				const analyzeDir = (dir: string, depth = 0): string => {
					if (depth > (deep ? 4 : 2)) return "";
					
					const entries = readdirSync(dir);
					let output = "";
					const indent = "  ".repeat(depth);
					
					for (const entry of entries.slice(0, 20)) {
						const fullPath = join(dir, entry);
						const entryStat = statSync(fullPath);
						
						if (entry.startsWith(".") || entry === "node_modules") continue;
						
						if (entryStat.isDirectory()) {
							output += `${indent}📁 ${entry}/\n`;
							output += analyzeDir(fullPath, depth + 1);
						} else {
							const ext = entry.split(".").pop();
							const icons: Record<string, string> = {
								ts: "🔷", tsx: "⚛️", js: "🟨", jsx: "⚛️",
								json: "📋", md: "📝", yml: "⚙️", yaml: "⚙️",
								sh: "🖥️", ps1: "💠",
							};
							output += `${indent}${icons[ext || ""] || "📄"} ${entry}\n`;
						}
					}
					return output;
				};
				
				// Detectar tecnologías
				const techDetect: Record<string, string[]> = {
					"Node.js": ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
					"Python": ["pyproject.toml", "requirements.txt", "setup.py"],
					"Docker": ["Dockerfile", "docker-compose.yml"],
					"TypeScript": [".ts", ".tsx"],
				};
				
				let output = `📊 Análisis de: ${pathArg}\n\n`;
				output += `📁 Estructura:\n${analyzeDir(projectPath)}\n`;
				
				// Detectar config
				const configFiles = ["package.json", "tsconfig.json", "docker-compose.yml", ".env.example"];
				output += `\n⚙️ Archivos de config:\n`;
				for (const cf of configFiles) {
					if (existsSync(resolve(projectPath, cf))) {
						output += `  ✓ ${cf}\n`;
					}
				}
				
				output += `\n💡 Puedes usar "self_modify" para modificar archivos de Shiro`;
				
				return { ok: true, content: output };
			}
			case "self_modify": {
				const file = args_.file ? String(args_.file).trim() : "";
				const search = args_.search ? String(args_.search).trim() : "";
				const replace = args_.replace ? String(args_.replace) : "";
				
				if (!file) return { ok: false, error: "El archivo es requerido" };
				if (!search) return { ok: false, error: "El texto a buscar es requerido" };
				
				// Solo permitir archivos en src/
				if (!file.startsWith("src/") && !file.startsWith("./src/")) {
					return { ok: false, error: "Solo puedes modificar archivos en src/" };
				}
				
				const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
				const { resolve } = await import("node:path");
				
				const workspace = getWorkspaceDir();
				const filePath = resolve(workspace, file);
				
				// Verificar que está dentro del workspace
				if (!filePath.startsWith(resolve(workspace))) {
					return { ok: false, error: "Path fuera del workspace" };
				}
				
				if (!existsSync(filePath)) {
					return { ok: false, error: "Archivo no existe: " + file };
				}
				
				const content = readFileSync(filePath, "utf-8");
				
				if (!content.includes(search)) {
					return { ok: false, error: "Texto no encontrado en el archivo. Asegúrate de que el texto sea exacto." };
				}
				
				if (replace) {
					const newContent = content.replace(search, replace);
					writeFileSync(filePath, newContent, "utf-8");
					return { ok: true, content: `✅ Modificado: ${file}\n\nAntes:\n${search.slice(0, 100)}...\n\nDespués:\n${replace.slice(0, 100)}...` };
				} else {
					// Solo buscar
					const lines = content.split("\n");
					let found = false;
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].includes(search)) {
							found = true;
							const start = Math.max(0, i - 2);
							const end = Math.min(lines.length, i + 3);
							return { 
								ok: true, 
								content: `✅ Encontrado en línea ${i + 1}:\n\n${lines.slice(start, end).join("\n")}` 
							};
						}
					}
					return { ok: false, error: "Texto no encontrado" };
				}
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
			case "self_analyze": {
				const { selfAnalyze } = await import("../self/SelfReflection.js");
				const result = await selfAnalyze();
				return { ok: true, content: result };
			}
			case "self_reflect": {
				const { listReflections, getPendingReflections } = await import("../self/SelfReflection.js");
				const pendingOnly = args_.pending === true;
				
				const reflections = pendingOnly ? getPendingReflections() : listReflections();
				
				if (reflections.length === 0) {
					return { ok: true, content: "No hay reflexiones registradas." };
				}
				
				let output = pendingOnly ? "📝 Reflexiones pendientes:\n\n" : "📝 Historial de reflexiones:\n\n";
				
				for (const r of reflections) {
					const status = r.implemented ? "✅" : "⏳";
					output += `${status} [${r.timestamp.slice(0, 10)}] ${r.trigger}\n`;
					output += `   📊 ${r.analysis.slice(0, 80)}...\n`;
					if (r.suggestions.length > 0) {
						output += `   💡 ${r.suggestions[0].slice(0, 60)}...\n`;
					}
					output += "\n";
				}
				
				return { ok: true, content: output };
			}
			case "ask_user": {
				const question = args_.question ? String(args_.question).trim() : "";
				
				if (!question) return { ok: false, error: "La pregunta es requerida" };
				
				return { 
					ok: true, 
					content: `🤔 PREGUNTA: ${question}\n\n(Responde a esta pregunta para que pueda ayudarte mejor)` 
				};
			}
			case "channel_create": {
				const { createChannel, startChannel } = await import("../channels/ChannelManager.js");
				const name = String(args_.name ?? "").trim();
				const type = String(args_.type ?? "").trim() as "telegram" | "discord" | "slack";
				const token = String(args_.token ?? "").trim();
				
				if (!name) return { ok: false, error: "El nombre es requerido" };
				if (!type) return { ok: false, error: "El tipo es requerido (telegram, discord, slack)" };
				if (!token) return { ok: false, error: "El token es requerido" };
				
				if (!["telegram", "discord", "slack"].includes(type)) {
					return { ok: false, error: `Tipo '${type}' no soportado. Usa: telegram, discord, slack` };
				}
				
				try {
					const channel = createChannel(name, type, { token });
					
					let msg = `✅ Canal creado: "${name}" (${type})\n`;
					msg += `   ID: ${channel.id}\n`;
					msg += `   Estado: ${channel.status}\n\n`;
					msg += "Ahora voy a iniciar el canal...";
					
					// Intentar iniciar automáticamente
					const result = await startChannel(channel.id);
					if (result.ok) {
						msg += `\n\n✅ Canal iniciado correctamente!`;
						msg += `\n\nPara Telegram: Busca "@${(channel.config as { botUsername?: string }).botUsername || 'tu_bot'}" en Telegram y envíale /start`;
					} else {
						msg += `\n\n⚠️ El canal se creó pero no se pudo iniciar: ${result.error}`;
					}
					
					return { ok: true, content: msg };
				} catch (err) {
					return { ok: false, error: "Error al crear canal: " + (err instanceof Error ? err.message : String(err)) };
				}
			}
			case "channel_list": {
				const { listChannels } = await import("../channels/ChannelManager.js");
				const channels = listChannels();
				
				if (channels.length === 0) {
					return { ok: true, content: "No hay canales configurados. Usa channel_create para crear uno." };
				}
				
				let output = "📡 Canales configurados:\n\n";
				for (const ch of channels) {
					const statusIcon = ch.status === "active" ? "🟢" : ch.status === "error" ? "🔴" : "⚪";
					output += `${statusIcon} ${ch.name} (${ch.type})\n`;
					output += `   ID: ${ch.id}\n`;
					output += `   Estado: ${ch.status}\n`;
					if (ch.lastError) output += `   Error: ${ch.lastError}\n`;
					output += "\n";
				}
				
				return { ok: true, content: output };
			}
			case "channel_start": {
				const { getChannel, startChannel } = await import("../channels/ChannelManager.js");
				const id = String(args_.id ?? "").trim();
				
				if (!id) return { ok: false, error: "El ID del canal es requerido" };
				
				const channel = getChannel(id);
				if (!channel) return { ok: false, error: "Canal no encontrado" };
				
				const result = await startChannel(id);
				if (result.ok) {
					return { ok: true, content: `✅ Canal "${channel.name}" iniciado correctamente!\n\nPara ${channel.type}: Busca tu bot y envíale /start` };
				}
				return { ok: false, error: `Error al iniciar: ${result.error}` };
			}
			case "channel_delete": {
				const { deleteChannel } = await import("../channels/ChannelManager.js");
				const id = String(args_.id ?? "").trim();
				
				if (!id) return { ok: false, error: "El ID del canal es requerido" };
				
				const deleted = deleteChannel(id);
				if (deleted) {
					return { ok: true, content: `✅ Canal eliminado: ${id}` };
				}
				return { ok: false, error: "Canal no encontrado" };
			}
			default:
				return { ok: false, error: "Herramienta desconocida: " + name };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
