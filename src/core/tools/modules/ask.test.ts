import { test } from "node:test";
import assert from "node:assert/strict";
import { executeAsk, type AskQuestion } from "./ask.js";
import { runWithAgentContext, type AgentRunContext } from "../../agent/runContext.js";
import { askUserSchema } from "../schemas.js";

const ctx = (extra: Partial<AgentRunContext>): AgentRunContext =>
	({ llm: {} as AgentRunContext["llm"], agentName: "Aku", mode: "chat", permissions: "ask", tools: undefined, subagent: false, launched: 0, ...extra }) as AgentRunContext;

const questions: AskQuestion[] = [{ question: "¿Para qué es?", options: ["Trabajo", "Casa"] }];

test("ask_user espera las respuestas de la web y se las pasa al modelo", async () => {
	let asked: AskQuestion[] = [];
	const r = await runWithAgentContext(
		ctx({
			asker: async (q) => {
				asked = q;
				return ["Trabajo"];
			},
		}),
		() => executeAsk({ questions }),
	);
	assert.equal(asked[0].question, "¿Para qué es?");
	assert.ok(r.ok);
	assert.match(r.content, /¿Para qué es\? → Trabajo/);
});

test("ask_user sin tarjetas (WhatsApp, ayudantes) pide preguntar en el texto", async () => {
	const none = await runWithAgentContext(ctx({}), () => executeAsk({ questions }));
	assert.match(none.content, /no se pueden mostrar tarjetas/);
	const helper = await runWithAgentContext(ctx({ subagent: true, asker: async () => ["x"] }), () => executeAsk({ questions }));
	assert.match(helper.content, /no se pueden mostrar tarjetas/);
	const skipped = await runWithAgentContext(ctx({ asker: async () => null }), () => executeAsk({ questions }));
	assert.match(skipped.content, /no respondió/);
});

test("askUserSchema acepta una sola pregunta suelta y opciones como texto", () => {
	const one = askUserSchema.parse({ question: "¿Color?", options: "rojo, azul" });
	assert.deepEqual(one.questions, [{ question: "¿Color?", options: ["rojo", "azul"] }]);
	assert.ok(!askUserSchema.safeParse({ questions: [1, 2, 3, 4].map((n) => ({ question: `q${n}`, options: [] })) }).success);
});
