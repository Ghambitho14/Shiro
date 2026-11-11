/**
 * Lo que el modelo hizo en su respuesta anterior. Entre un mensaje y otro solo se guarda el texto de
 * cada respuesta: los resultados de las herramientas se pierden. Con esta nota sabe al menos qué
 * miró y qué ejecutó (y la lista de tareas que llevaba), para seguir sin repetirlo todo.
 */
import type { Message } from "./Types.js";

export type TodoStatus = "pending" | "in_progress" | "done";
export type TodoItem = { text: string; status: TodoStatus };
export type PreviousStep = { name?: string; label: string; ok?: boolean };

type WorkMessage = { role: string; tools?: readonly PreviousStep[]; todo?: readonly TodoItem[] };

const MAX_STEPS = 12;

export function formatTodo(items: readonly TodoItem[]): string {
	return items.map((t) => `- [${t.status === "done" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.text}`).join("\n");
}

/**
 * Pega una nota delante del último mensaje del usuario (devuelve otra lista; la original no cambia).
 * Va ahí y no en las instrucciones porque es donde el modelo mira: arriba del todo, los modelos chicos
 * la pasaban por alto y decían no haber usado herramientas.
 */
export function withSystemNote(messages: Message[], note: string | undefined): Message[] {
	const i = messages.length - 1;
	const last = messages[i];
	if (!note || !last || last.role !== "user") return messages;
	const text = `[Nota del sistema; no la escribió el usuario]\n${note}\n[Fin de la nota]`;
	const content = typeof last.content === "string" ? `${text}\n\n${last.content}` : [{ type: "text" as const, text }, ...last.content];
	return [...messages.slice(0, i), { role: "user", content }];
}

/** La nota con lo que hizo en la respuesta anterior, o undefined si no usó herramientas. */
export function buildPreviousWork(conversation: readonly WorkMessage[] | undefined, maxChars = 900): string | undefined {
	const last = [...(conversation ?? [])].reverse().find((m) => m.role === "assistant");
	if (!last) return undefined;
	// La lista de tareas va aparte: sus llamadas no cuentan como pasos.
	const steps = (last.tools ?? []).filter((t) => t.name !== "todo" && t.label?.trim());
	const todo = last.todo?.length ? `\nLista de tareas que llevabas ([x] hecha, [~] a medias):\n${formatTodo(last.todo)}` : "";
	if (!steps.length && !todo) return undefined;

	const head = "## Lo que hiciste en tu respuesta anterior";
	if (!steps.length) return (head + todo).slice(0, maxChars);
	const intro = "Usaste estas herramientas. Sus resultados ya no están aquí: lo que encontraste es lo que dice tu respuesta. Si necesitas un dato exacto, vuelve a mirarlo.";
	let shown = steps.slice(-MAX_STEPS);
	const build = () => {
		const skipped = steps.length - shown.length;
		const lines = shown.map((t) => `- ${t.ok === false ? "✗" : "✓"} ${t.label.trim().slice(0, 140)}${t.ok === false ? " (falló)" : ""}`);
		return `${head}\n${intro}\n${skipped > 0 ? `(y ${skipped} pasos antes)\n` : ""}${lines.join("\n")}${todo}`;
	};
	let text = build();
	// Si no cabe, se quitan los pasos más viejos.
	while (text.length > maxChars && shown.length > 1) {
		shown = shown.slice(1);
		text = build();
	}
	return text.slice(0, maxChars);
}
