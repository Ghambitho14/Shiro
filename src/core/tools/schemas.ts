import { z } from "zod";

/** Algunos modelos mandan los booleanos como texto ("true"/"false"). */
const optionalBool = z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() === "true" : v), z.boolean().optional());

/** Los números usan coerce: algunos modelos locales los mandan como texto ("50"). */
const optionalNumber = (min: number, max: number) => z.coerce.number().min(min).max(max).optional();

export const readFileSchema = z.object({
	path: z.string().min(1, "path requerido"),
	line: optionalNumber(1, 1e9),
	lines: optionalNumber(1, 5000),
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
	line: optionalNumber(1, 1e9),
	lines: optionalNumber(1, 5000),
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
	offset: optionalNumber(0, 1e9),
	find: z.string().trim().max(200).optional(),
});

export const searchWebSchema = z.object({
	query: z.string().min(1, "query requerida").max(200, "query demasiado larga"),
});

export const cveSearchSchema = z
	.object({
		id: z.string().trim().max(40).optional(),
		vendor: z.string().trim().max(80).optional(),
		product: z.string().trim().max(80).optional(),
	})
	.refine((v) => v.id || v.vendor || v.product, { message: "indica id (CVE-AAAA-NNNN) o product" });

export const execSchema = z.object({
	command: z.string().min(1, "comando requerido").max(1000, "comando demasiado largo"),
	timeout: z.number().optional().default(30000),
	workingDir: z.string().optional(),
});

export const cronCreateSchema = z.object({
	name: z.string().min(1, "nombre requerido").max(120, "nombre demasiado largo"),
	expression: z.string().min(1, "horario requerido").max(100, "horario demasiado largo"),
	action: z.enum(["agent", "notify", "reminder", "exec"]),
	prompt: z.string().max(4000, "instrucción demasiado larga").optional(),
	message: z.string().max(2000, "mensaje demasiado largo").optional(),
	command: z.string().max(1000, "comando demasiado largo").optional(),
	deliver: z.enum(["both", "web", "telegram"]).optional(),
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
		action: z.enum(["read", "run", "write", "stop"]).default("read"),
		command: z.string().trim().max(8000, "comando demasiado largo").optional(),
		// Sin trim: los espacios pueden importar a quien lo recibe.
		text: z.string().max(64_000, "texto demasiado largo").optional(),
		enter: optionalBool,
		keys: z.string().trim().max(200, "demasiadas teclas").optional(),
		lines: optionalNumber(5, 400),
		timeout_seconds: optionalNumber(1, 600),
		wait_seconds: optionalNumber(1, 300),
	})
	.refine((a) => a.action !== "run" || Boolean(a.command), { message: "indica 'command' con el comando a ejecutar" })
	.refine((a) => a.action !== "write" || Boolean(a.text || a.keys || a.enter), { message: "indica 'text' con lo que hay que teclear o 'keys' con las teclas" });

export const claudeCodeSchema = z.object({
	task: z.string().trim().min(1, "indica la tarea (task)").max(20000, "tarea demasiado larga"),
	folder: z.string().trim().max(1000).optional(),
	continue: optionalBool,
	timeout_minutes: optionalNumber(1, 60),
});

export const delegateSchema = z.object({
	tasks: z
		.array(
			z.object({
				task: z.string().trim().min(1, "cada tarea necesita su texto (task)").max(8000, "tarea demasiado larga"),
				agent: z.string().trim().max(60).optional(),
				name: z.string().trim().max(60).optional(),
			}),
		)
		.min(1, "indica al menos una tarea en tasks")
		.max(4, "como mucho 4 tareas a la vez"),
	timeout_minutes: optionalNumber(1, 20),
});

export const projectSchema = z
	.object({
		action: z.enum(["list", "find", "search", "semantic", "read", "edit", "write"]).default("list"),
		path: z.string().trim().max(1000).optional(),
		query: z.string().trim().max(300).optional(),
		files: z.string().trim().max(200).optional(),
		context: optionalNumber(0, 3),
		line: optionalNumber(1, 1e9),
		lines: optionalNumber(1, 5000),
		offset: optionalNumber(0, 1e9),
		// Sin trim: los espacios del principio (la sangría) son parte del texto a cambiar.
		old_text: z.string().max(200_000, "old_text demasiado largo").optional(),
		new_text: z.string().max(2_000_000, "new_text demasiado largo").optional(),
		replace_all: optionalBool,
		content: z.string().max(2_000_000, "contenido demasiado largo").optional(),
	})
	.refine((a) => a.action !== "read" || Boolean(a.path), { message: "indica 'path' con el archivo a leer" })
	.refine((a) => (a.action !== "search" && a.action !== "find") || Boolean(a.query), { message: "indica 'query' con lo que quieres buscar" })
	.refine((a) => a.action !== "write" || (Boolean(a.path) && a.content !== undefined), { message: "indica 'path' y 'content'" })
	.refine((a) => a.action !== "edit" || (Boolean(a.path) && Boolean(a.old_text) && a.new_text !== undefined), {
		message: "indica 'path', 'old_text' (el trozo exacto que hay ahora) y 'new_text' (cómo debe quedar)",
	});

/** Estados de una tarea; se aceptan los nombres que usan otros programas (completed, in-progress…). */
const todoStatus = z.preprocess((v) => {
	const s = String(v ?? "pending").trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (/^(done|completed?|hech[oa]|terminad[oa]|finished|list[oa])$/.test(s)) return "done";
	if (/^(in_progress|en_curso|en_progreso|doing|active|working)$/.test(s)) return "in_progress";
	return "pending";
}, z.enum(["pending", "in_progress", "done"]));

const todoItem = z.preprocess(
	// Otros programas llaman «content» al texto de la tarea.
	(v) => (v && typeof v === "object" && !("text" in v) && "content" in v ? { ...v, text: (v as { content: unknown }).content } : typeof v === "string" ? { text: v } : v),
	z.object({ text: z.string().trim().min(1, "cada tarea necesita su texto").max(200), status: todoStatus }),
);

export const todoSchema = z.preprocess(
	(v) => {
		if (!v || typeof v !== "object" || "items" in v) return v;
		const o = v as Record<string, unknown>;
		return { ...o, items: o.todos ?? o.tasks };
	},
	z.object({ items: z.array(todoItem).min(1, "indica al menos una tarea en items").max(20, "como mucho 20 tareas") }),
);

/** Una lista que el modelo a veces manda como texto separado por comas. */
const stringList = z.preprocess(
	(v) => (typeof v === "string" ? v.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) : v),
	z.array(z.string().trim().min(1).max(300)).max(50),
);

export const pentestSchema = z.object({
	action: z.enum(["scope", "add_finding", "update_finding", "list", "report"]),
	name: z.string().max(120).optional(),
	targets: stringList.optional(),
	out_of_scope: stringList.optional(),
	limits: z.string().max(1000).optional(),
	authorized_by: z.string().max(200).optional(),
	id: z.coerce.number().int().positive().optional(),
	title: z.string().max(200).optional(),
	severity: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^critical$/, "critica").replace(/^(high)$/, "alta").replace(/^medium$/, "media").replace(/^low$/, "baja").replace(/^informativ[ao]$/, "info") : v), z.enum(["critica", "alta", "media", "baja", "info"])).optional(),
	status: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase().replace(/^confirmed$/, "confirmado").replace(/^(likely|probable)$/, "probable").replace(/^(discarded|false.positive)$/, "descartado") : v), z.enum(["confirmado", "probable", "descartado"])).optional(),
	asset: z.string().max(500).optional(),
	description: z.string().max(2000).optional(),
	risk: z.string().max(2000).optional(),
	evidence: z.string().max(6000).optional(),
	cve: stringList.optional(),
	fix: z.string().max(2000).optional(),
	summary: z.string().max(3000).optional(),
	checked_ok: z.string().max(3000).optional(),
	not_checked: z.string().max(3000).optional(),
});

export const emailSchema = z.object({
	action: z.enum(["search", "read", "draft", "send"]),
	query: z.string().max(500).optional(),
	max: z.coerce.number().int().min(1).max(25).optional(),
	id: z.string().trim().regex(/^[\w-]{1,100}$/, "id de correo no válido").optional(),
	offset: z.coerce.number().int().min(0).optional(),
	to: z.string().max(1000).optional(),
	cc: z.string().max(1000).optional(),
	subject: z.string().max(500).optional(),
	body: z.string().max(50_000).optional(),
	reply_to_id: z.string().trim().regex(/^[\w-]{1,100}$/, "id de correo no válido").optional(),
});

export const calendarSchema = z.object({
	action: z.enum(["list", "create"]),
	from: z.string().max(40).optional(),
	to: z.string().max(40).optional(),
	query: z.string().max(300).optional(),
	max: z.coerce.number().int().min(1).max(50).optional(),
	title: z.string().max(300).optional(),
	start: z.string().max(40).optional(),
	end: z.string().max(40).optional(),
	location: z.string().max(500).optional(),
	description: z.string().max(5000).optional(),
	attendees: stringList.optional(),
});

export const useSkillSchema = z.object({
	name: z.string().trim().max(200).optional(),
	file: z.string().trim().max(500).optional(),
	offset: z.number().int().min(0).optional(),
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
	cve_search: cveSearchSchema,
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
	claude_code: claudeCodeSchema,
	delegate: delegateSchema,
	use_skill: useSkillSchema,
	project: projectSchema,
	todo: todoSchema as z.ZodType<Record<string, unknown>>,
	pentest: pentestSchema as z.ZodType<Record<string, unknown>>,
	email: emailSchema,
	calendar: calendarSchema as z.ZodType<Record<string, unknown>>,
};
