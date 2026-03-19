/**
 * Tool: cron_list - Lista tareas programadas
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const cronListTool = {
	name: "cron_list",
	description: "Lista todas las tareas programadas activas.",
	category: "tareas",
	parameters: {
		type: "object",
		properties: {},
	},
};

async function executeCronList(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { listCronTasks } = await import("../../../scheduler/CronService.js");
	const tasks = listCronTasks();
	
	if (tasks.length === 0) {
		return { ok: true, content: "No hay tareas programadas." };
	}
	
	let output = "Tareas Programadas:\n\n";
	for (const t of tasks) {
		const status = t.enabled ? "✅" : "⏸️";
		const lastRun = t.lastRun ? new Date(t.lastRun).toLocaleString() : "nunca";
		output += `${status} ${t.name}\n`;
		output += `   ID: ${t.id}\n`;
		output += `   Frecuencia: ${t.expression}\n`;
		output += `   Accion: ${t.action}\n`;
		output += `   Ultimo: ${lastRun}\n\n`;
	}
	
	return { ok: true, content: output };
}

registerToolExecutor("cron_list", executeCronList);
