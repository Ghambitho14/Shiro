import { z } from "zod";

/** Algunos modelos mandan los booleanos como texto ("true"/"false"). */
const optionalBool = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() === "true" : v), z.boolean().optional());

export const readFileSchema = z.object({
	path: z.string().min(1, "path requerido"),
});

export const writeFileSchema = z.object({
	path: z.string().min(1, "path requerido"),
	content: z.string().optional().default(""),
});

export const listDirSchema = z.object({
	path: z.string().optional().default(""),
});

export const readFileSystemSchema = z.object({
	path: z.string().min(1, "path requerido"),
});

export const writeFileSystemSchema = z.object({
	path: z.string().min(1, "path requerido"),
	content: z.string().optional().default(""),
});

export const listDirSystemSchema = z.object({
	path: z.string().optional().default(""),
});

export const fetchUrlSchema = z.object({
	url: z.string().url("URL inválida"),
});

export const searchWebSchema = z.object({
	query: z.string().min(1, "query requerida").max(200, "query demasiado larga"),
});

export const execSchema = z.object({
	command: z.string().min(1, "comando requerido").max(1000, "comando demasiado largo"),
	timeout: z.number().optional().default(30000),
	workingDir: z.string().optional(),
});

export const cronCreateSchema = z.object({
	name: z.string().min(1, "nombre requerido"),
	expression: z.string().min(1, "expresión requerida"),
	action: z.enum(["notify", "exec", "reminder"]),
	message: z.string().optional(),
	command: z.string().optional(),
});

export const cronListSchema = z.object({});

export const cronDeleteSchema = z.object({
	id: z.string().min(1, "id requerido"),
});

export const cronToggleSchema = z.object({
	id: z.string().min(1, "id requerido"),
	enabled: z.boolean(),
});

export const gitSchema = z.object({
	command: z.string().min(1, "comando requerido"),
	repoPath: z.string().optional().default("."),
});

export const createReminderSchema = z.object({
	title: z.string().min(1, "título requerido"),
	datetime: z.string().min(1, "fecha y hora requerida"),
	description: z.string().optional(),
	repeat: z.enum(["daily", "weekly", "monthly", "none"]).optional().default("none"),
});

export const listRemindersSchema = z.object({
	include_completed: z.boolean().optional().default(false),
});

export const completeReminderSchema = z.object({
	id: z.string().min(1, "id requerido"),
});

export const describeImageSchema = z.object({
	url: z.string().min(1, "url requerida"),
});

export const memorySearchSchema = z.object({
	query: z.string().min(1, "query requerida"),
	limit: z.number().optional(),
});

export const memoryAddSchema = z.object({
	content: z.string().min(1, "contenido requerido"),
	type: z.string().optional(),
	tags: z.array(z.string()).optional(),
	important: optionalBool,
});

export const sessionsListSchema = z.object({});

export const sessionsHistorySchema = z.object({
	sessionId: z.string().optional(),
	limit: z.number().optional().default(50),
});

// ---------- Control del PC ----------
// Los números usan coerce: algunos modelos locales los mandan como texto ("50").

const optionalNumber = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();

export const pcOpenSchema = z.object({
	target: z.string().trim().min(1, "indica qué abrir").max(2000),
});

export const pcScreenshotSchema = z.object({});

export const pcKeyboardSchema = z
	.object({
		text: z.string().max(5000, "texto demasiado largo (máx. 5000)").optional(),
		keys: z.string().trim().max(200).optional(),
		window: z.string().trim().max(200).optional(),
	})
	.refine((a) => Boolean(a.text) || Boolean(a.keys), { message: "indica 'text' (texto a escribir) o 'keys' (teclas a pulsar)" });

export const pcMouseSchema = z.object({
	action: z.enum(["click", "double_click", "right_click", "move", "scroll_up", "scroll_down"]),
	x: optionalNumber(0, 20000),
	y: optionalNumber(0, 20000),
	amount: optionalNumber(1, 30),
});

export const pcMediaSchema = z.object({
	action: z.enum(["volume_up", "volume_down", "set_volume", "get_volume", "mute", "unmute", "play_pause", "next", "previous", "stop"]),
	value: optionalNumber(0, 100),
});

export const pcWindowsSchema = z.object({
	action: z.enum(["list", "focus", "minimize", "maximize", "restore", "close", "show_desktop"]),
	title: z.string().trim().max(200).optional(),
});

export const pcProcessesSchema = z.object({
	action: z.enum(["list", "kill"]).default("list"),
	name: z.string().trim().max(100).optional(),
});

export const pcClipboardSchema = z.object({
	action: z.enum(["read", "write"]),
	text: z.string().max(20000).optional(),
});

export const pcSystemSchema = z.object({});

export const pcPowerSchema = z.object({
	action: z.enum(["lock", "sleep", "shutdown", "restart", "logoff", "cancel"]),
	delay_minutes: optionalNumber(0, 1440),
});

export const browserSchema = z
	.object({
		action: z.enum(["open", "read", "click", "type", "scroll", "back", "screenshot", "close"]),
		url: z.string().trim().max(2000).optional(),
		ref: optionalNumber(1, 10000),
		text: z.string().max(5000, "texto demasiado largo (máx. 5000)").optional(),
		enter: optionalBool,
		direction: z.enum(["up", "down"]).optional(),
	})
	.superRefine((a, ctx) => {
		if (a.action === "open" && !a.url) ctx.addIssue({ code: "custom", path: ["url"], message: "indica 'url': la dirección o lo que quieres buscar" });
		if ((a.action === "click" || a.action === "type") && a.ref === undefined) {
			ctx.addIssue({ code: "custom", path: ["ref"], message: "indica 'ref': el número [n] del elemento según la última lectura de la página" });
		}
	});

export const terminalSchema = z
	.object({
		action: z.enum(["read", "run", "stop"]).default("read"),
		command: z.string().trim().max(8000, "comando demasiado largo").optional(),
		lines: optionalNumber(5, 400),
		timeout_seconds: optionalNumber(1, 600),
	})
	.refine((a) => a.action !== "run" || Boolean(a.command), { message: "indica 'command' con el comando a ejecutar" });

export const projectSchema = z
	.object({
		action: z.enum(["list", "read", "search", "write"]).default("list"),
		path: z.string().trim().max(1000).optional(),
		query: z.string().trim().max(300).optional(),
		offset: optionalNumber(0, 1e9),
		content: z.string().max(2_000_000, "contenido demasiado largo").optional(),
	})
	.refine((a) => a.action !== "read" || Boolean(a.path), { message: "indica 'path' con el archivo a leer" })
	.refine((a) => a.action !== "search" || Boolean(a.query), { message: "indica 'query' con lo que quieres buscar" })
	.refine((a) => a.action !== "write" || (Boolean(a.path) && a.content !== undefined), { message: "indica 'path' y 'content'" });

export const useSkillSchema = z.object({
	name: z.string().trim().max(200).optional(),
	file: z.string().trim().max(500).optional(),
});

export const toolSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
	read_file: readFileSchema,
	write_file: writeFileSchema,
	list_dir: listDirSchema,
	read_file_system: readFileSystemSchema,
	write_file_system: writeFileSystemSchema,
	list_dir_system: listDirSystemSchema,
	fetch_url: fetchUrlSchema,
	search_web: searchWebSchema,
	exec: execSchema,
	cron_create: cronCreateSchema,
	cron_list: cronListSchema,
	cron_delete: cronDeleteSchema,
	cron_toggle: cronToggleSchema,
	git: gitSchema,
	create_reminder: createReminderSchema,
	list_reminders: listRemindersSchema,
	complete_reminder: completeReminderSchema,
	describe_image: describeImageSchema,
	memory_search: memorySearchSchema,
	memory_add: memoryAddSchema,
	sessions_list: sessionsListSchema,
	sessions_history: sessionsHistorySchema,
	pc_open: pcOpenSchema,
	pc_screenshot: pcScreenshotSchema,
	pc_keyboard: pcKeyboardSchema,
	pc_mouse: pcMouseSchema,
	pc_media: pcMediaSchema,
	pc_windows: pcWindowsSchema,
	pc_processes: pcProcessesSchema,
	pc_clipboard: pcClipboardSchema,
	pc_system: pcSystemSchema,
	pc_power: pcPowerSchema,
	browser: browserSchema,
	terminal: terminalSchema,
	use_skill: useSkillSchema,
	project: projectSchema,
};
