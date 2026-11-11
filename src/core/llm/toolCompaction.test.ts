import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../agent/Types.js";
import { COMPACTED_NOTE, compactToolResults } from "./toolCompaction.js";

const tool = (content: string, name = "project"): Message => ({ role: "tool", tool_call_id: "x", name, content });
const text = (m: Message) => (m as { content: string }).content;

test("recorta los resultados más viejos hasta que caben, sin tocar los últimos ni lo de antes de esta respuesta", () => {
	const msgs: Message[] = [
		{ role: "system", content: "s" },
		tool("v".repeat(5000)), // de una respuesta anterior: no se toca
		{ role: "user", content: "pregunta" },
		tool("a".repeat(4000)),
		tool("b".repeat(4000)),
		tool("c".repeat(4000)),
		tool("d".repeat(4000)),
	];
	assert.equal(compactToolResults(msgs, 3, 20_000), 0);
	// Sobran 6.000 letras: recortar el primero no alcanza, el segundo sí.
	assert.equal(compactToolResults(msgs, 3, 10_000), 2);
	assert.equal(text(msgs[1]!).length, 5000);
	for (const i of [3, 4]) {
		const c = text(msgs[i]!);
		assert.ok(c.startsWith(i === 3 ? "aaa" : "bbb") && c.endsWith(COMPACTED_NOTE) && c.length < 500);
	}
	assert.equal(text(msgs[5]!).length, 4000);
	assert.equal(text(msgs[6]!).length, 4000);
	// Lo ya recortado no se vuelve a recortar.
	assert.equal(compactToolResults(msgs, 3, 10_000), 0);
});

test("no recorta las instrucciones de una habilidad ni los resultados cortos; entiende el modo texto", () => {
	const msgs: Message[] = [
		tool("i".repeat(6000), "use_skill"),
		tool("corto"),
		{ role: "user", content: `<tool_result name="project">\n${"t".repeat(6000)}\n</tool_result>` },
		{ role: "user", content: `<tool_result name="use_skill">\n${"t".repeat(6000)}\n</tool_result>` },
		{ role: "user", content: "un mensaje normal del usuario, " + "u".repeat(6000) },
		tool("z".repeat(100)),
	];
	assert.equal(compactToolResults(msgs, 0, 0, 1), 1);
	assert.equal(text(msgs[0]!).length, 6000);
	assert.equal(text(msgs[1]!), "corto");
	assert.ok(text(msgs[2]!).endsWith(COMPACTED_NOTE));
	assert.ok(text(msgs[3]!).length > 6000);
	assert.ok(text(msgs[4]!).length > 6000);
});
