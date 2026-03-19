/**
 * Tool: cron_toggle - Activa/desactiva tarea
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const cronToggleTool = {
	name: "cron_toggle",
	description: "Activa o desactiva una tarea programada sin eliminarla.",
	category: "tareas",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "ID de la tarea" },
			enabled: { type: "boolean", description: "true para activar, false para desactivar" },
		},
		required: ["id", "enabled"],
	},
};

async function executeCronToggle(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { toggleCronTask } = await import("../../../scheduler/CronService.js");
	const id = String(args.id ?? "").trim();
	const enabled = args.enabled === true;
	
	if (!id) return { ok: false, content: "El ID es requerido" };
	
	const task = toggleCronTask(id, enabled);
	if (task) {
		const status = task.enabled ? "activada" : "desactivada";
		return { ok: true, content: `Tarea ${status}: ${task.name}` };
	}
	return { ok: false, content: "Tarea no encontrada" };
}

registerToolExecutor("cron_toggle", executeCronToggle);
