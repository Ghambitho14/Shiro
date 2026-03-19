/**
 * Tool: cron_delete - Elimina tarea programada
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const cronDeleteTool = {
	name: "cron_delete",
	description: "Elimina una tarea programada por su ID.",
	category: "tareas",
	parameters: {
		type: "object",
		properties: {
			id: { type: "string", description: "ID de la tarea" },
		},
		required: ["id"],
	},
};

async function executeCronDelete(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { deleteCronTask } = await import("../../../scheduler/CronService.js");
	const id = String(args.id ?? "").trim();
	
	if (!id) return { ok: false, content: "El ID es requerido" };
	
	const deleted = deleteCronTask(id);
	if (deleted) {
		return { ok: true, content: `Tarea eliminada: ${id}` };
	}
	return { ok: false, content: "Tarea no encontrada" };
}

registerToolExecutor("cron_delete", executeCronDelete);
