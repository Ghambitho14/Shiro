import { z } from "zod";

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

export const projectAnalyzeSchema = z.object({
	path: z.string().optional().default("."),
	deep: z.boolean().optional().default(false),
});

export const selfModifySchema = z.object({
	file: z.string().min(1, "archivo requerido"),
	search: z.string().min(1, "texto a buscar requerido"),
	replace: z.string().optional().default(""),
});

export const gitSchema = z.object({
	command: z.string().min(1, "comando requerido"),
	repoPath: z.string().optional().default("."),
});

export const selfAnalyzeSchema = z.object({});

export const selfReflectSchema = z.object({
	pending: z.boolean().optional(),
});

export const askUserSchema = z.object({
	question: z.string().min(1, "pregunta requerida"),
});

export const channelCreateSchema = z.object({
	name: z.string().min(1, "nombre requerido"),
	type: z.enum(["telegram", "discord", "slack"]),
	token: z.string().min(1, "token requerido"),
});

export const channelListSchema = z.object({});

export const channelStartSchema = z.object({
	id: z.string().min(1, "id requerido"),
});

export const channelDeleteSchema = z.object({
	id: z.string().min(1, "id requerido"),
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
});

export const sessionsListSchema = z.object({});

export const sessionsHistorySchema = z.object({
	sessionId: z.string().optional(),
	limit: z.number().optional().default(50),
});

export const executePythonSchema = z.object({
	code: z.string().min(1, "código requerido").max(5000, "código demasiado largo"),
	timeout: z.number().min(1000).max(30000).optional().default(10000),
});

export const httpRequestSchema = z.object({
	url: z.string().url("URL inválida"),
	method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
	headers: z.record(z.string()).optional(),
	body: z.string().optional(),
});

export type SearchWebArgs = z.infer<typeof searchWebSchema>;
export type ExecArgs = z.infer<typeof execSchema>;
export type CronCreateArgs = z.infer<typeof cronCreateSchema>;
export type CronListArgs = z.infer<typeof cronListSchema>;
export type CronDeleteArgs = z.infer<typeof cronDeleteSchema>;
export type CronToggleArgs = z.infer<typeof cronToggleSchema>;
export type ProjectAnalyzeArgs = z.infer<typeof projectAnalyzeSchema>;
export type SelfModifyArgs = z.infer<typeof selfModifySchema>;
export type GitArgs = z.infer<typeof gitSchema>;
export type SelfAnalyzeArgs = z.infer<typeof selfAnalyzeSchema>;
export type SelfReflectArgs = z.infer<typeof selfReflectSchema>;
export type AskUserArgs = z.infer<typeof askUserSchema>;

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
	project_analyze: projectAnalyzeSchema,
	self_modify: selfModifySchema,
	git: gitSchema,
	self_analyze: selfAnalyzeSchema,
	self_reflect: selfReflectSchema,
	ask_user: askUserSchema,
	channel_create: channelCreateSchema,
	channel_list: channelListSchema,
	channel_start: channelStartSchema,
	channel_delete: channelDeleteSchema,
	create_reminder: createReminderSchema,
	list_reminders: listRemindersSchema,
	complete_reminder: completeReminderSchema,
	describe_image: describeImageSchema,
	memory_search: memorySearchSchema,
	memory_add: memoryAddSchema,
	sessions_list: sessionsListSchema,
	sessions_history: sessionsHistorySchema,
	execute_python: executePythonSchema,
	http_request: httpRequestSchema,
};
