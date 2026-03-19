/**
 * Tool: ask_user - Pregunta algo al usuario
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const askUserTool = {
	name: "ask_user",
	description: "Pregunta algo al usuario cuando necesitas más detalles o confirmación",
	category: "meta",
	parameters: {
		type: "object",
		properties: {
			question: {
				type: "string",
				description: "La pregunta que quieres hacerle al usuario"
			}
		},
		required: ["question"]
	},
	examples: [
		'"no estoy seguro de qué quieres decir" -> ask_user({ question: "¿Te refieres a...?" })',
	],
};

async function executeAskUser(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const question = args.question as string;
	return { 
		ok: true, 
		content: `[Pregunta al usuario]: ${question}` 
	};
}

registerToolExecutor("ask_user", executeAskUser);
