/**
 * Tool: cron_create - Crea tarea programada
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const cronCreateTool = {
	name: "cron_create",
	description: "Crea una tarea que se ejecuta periodicamente. Usa esto para recordatorios recurrentes o tareas de mantenimiento.",
	category: "tareas",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "Nombre de la tarea" },
			expression: { type: "string", description: "Frecuencia: '30 minutos', '2 horas', '1 dia'" },
			action: { type: "string", description: "Tipo: notify, exec, reminder" },
			message: { type: "string", description: "Mensaje para notify/reminder" },
			command: { type: "string", description: "Comando a ejecutar (para action=exec)" },
		},
		required: ["name", "expression", "action"],
	},
};

async function executeCronCreate(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { createCronTask } = await import("../../../scheduler/CronService.js");
	const name = String(args.name ?? "").trim();
	const expression = String(args.expression ?? "").trim();
	const action = String(args.action ?? "notify") as "notify" | "exec" | "reminder";
	const message = args.message ? String(args.message) : undefined;
	const command = args.command ? String(args.command) : undefined;
	
	if (!name) return { ok: false, content: "El nombre es requerido" };
	if (!expression) return { ok: false, content: "La expresion es requerida" };
	
	const payload: Record<string, unknown> = {};
	if (message) payload.message = message;
	if (command) payload.command = command;
	
	try {
		const task = createCronTask(name, expression, action, payload);
		return { 
			ok: true, 
			content: `Tarea creada: "${task.name}" (ID: ${task.id})\n   Frecuencia: ${task.expression}\n   Accion: ${task.action}` 
		};
	} catch (err) {
		return { 
			ok: false, 
			content: "Error al crear tarea: " + (err instanceof Error ? err.message : String(err)) 
		};
	}
}

registerToolExecutor("cron_create", executeCronCreate);
