import { currentAgentRun } from "../../agent/runContext.js";
import type { TodoItem } from "../../agent/previousWork.js";

/**
 * todo: la lista de tareas de un trabajo largo. El modelo manda la lista completa cada vez; se guarda
 * en la respuesta en curso y se le enseña al usuario en el chat (evento `todo`). No tiene más efectos.
 */
export async function executeTodo(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const ctx = currentAgentRun();
	if (!ctx) return { ok: false, content: "La lista de tareas solo funciona dentro de una respuesta de Aku." };
	const items = (Array.isArray(args.items) ? args.items : []) as TodoItem[];
	if (!items.length) return { ok: false, content: "Indica las tareas en items (cada una con text y status)." };
	ctx.todo = items;
	ctx.onTodo?.(items);
	const done = items.filter((t) => t.status === "done").length;
	const doing = items.filter((t) => t.status === "in_progress");
	const next = doing[0] ?? items.find((t) => t.status === "pending");
	if (done === items.length) return { ok: true, content: `Lista guardada: las ${items.length} tareas están hechas. Cierra con tu respuesta al usuario.` };
	const warn = doing.length > 1 ? " Deja en in_progress solo una." : "";
	return { ok: true, content: `Lista guardada: ${done} de ${items.length} hechas. ${doing.length ? "Ahora" : "Sigue con"}: «${next?.text ?? ""}».${warn}` };
}
