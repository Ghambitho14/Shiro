import { currentAgentRun } from "../../agent/runContext.js";

/**
 * ask_user: preguntarle al usuario antes de responder, con opciones para elegir (como la tarjeta de
 * permisos). La web la pinta como tarjeta y espera; en WhatsApp, Telegram o tareas programadas no hay
 * tarjetas, así que el modelo pregunta en su respuesta y termina ahí.
 */
export type AskQuestion = { question: string; options: string[]; multiple?: boolean };
/** Por pregunta, lo que eligió o escribió el usuario. null = no respondió (cerró, canceló o se pasó el tiempo). */
export type Asker = (questions: AskQuestion[]) => Promise<string[] | null>;

const NO_CARDS =
	"Aquí no se pueden mostrar tarjetas. Escribe tus preguntas en la respuesta, cada una con sus opciones numeradas, y termina ahí: el usuario contestará en su próximo mensaje.";

export async function executeAsk(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const questions = (Array.isArray(args.questions) ? args.questions : []) as AskQuestion[];
	if (!questions.length) return { ok: false, content: "Indica las preguntas en questions (cada una con question y options)." };
	const ctx = currentAgentRun();
	if (!ctx?.asker || ctx.subagent) return { ok: true, content: NO_CARDS };
	const answers = await ctx.asker(questions);
	if (!answers) {
		return {
			ok: true,
			content: "El usuario no respondió las preguntas. Sigue con lo más razonable y dilo, o pregunta en tu respuesta si sin eso no puedes seguir.",
		};
	}
	const lines = questions.map((q, i) => `- ${q.question} → ${answers[i]?.trim() || "(sin respuesta)"}`);
	return { ok: true, content: `Respuestas del usuario:\n${lines.join("\n")}\nSigue con esto: investiga lo que haga falta y responde.` };
}
