import { after, test } from "node:test";
import { strictEqual } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carpeta temporal: las instrucciones que el usuario cambió en Ajustes no cuentan aquí.
const TMP = mkdtempSync(join(tmpdir(), "shiro-context-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { buildContext, buildRoomBlock } = await import("./ContextBuilder.js");
const { MemoryManager } = await import("../memory/MemoryManager.js");
const { getSoul } = await import("../soul/soul.js");

/** Las instrucciones base llevan la hora: se calculan antes y después por si cambia el minuto. */
function withSoul(agentName: string, build: () => string): { out: string; souls: string[] } {
	const before = getSoul(agentName);
	const out = build();
	return { out, souls: [before, getSoul(agentName)] };
}

test("buildContext respects token budget and includes soul", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		shortMemory: memory,
		tokenBudget: 2000,
	});
	strictEqual(typeof out.system, "string");
	strictEqual(out.system.length > 0, true);
	strictEqual(out.system.includes("TestAgent"), true);
	strictEqual(Array.isArray(out.messages), true);
	strictEqual(out.messages.length >= 1, true);
	strictEqual(out.messages[0].role, "user");
	strictEqual(out.messages[0].content, "List files");
});

test("buildContext with long memory includes summary", () => {
	const memory = new MemoryManager();
	memory.setLongTerm({ summary: "Previous session summary.", keyFacts: [], openTasks: [] });
	const out = buildContext({
		goal: "Continue",
		agentName: "A",
		shortMemory: memory,
		tokenBudget: 4000,
	});
	strictEqual(out.system.includes("Previous session summary"), true);
});

test("buildContext no duplica el manifiesto de tools (van por la API)", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		shortMemory: memory,
		tokenBudget: 2000,
	});

	strictEqual(out.system.includes("## Herramientas disponibles"), false);
});

test("buildContext añade las reglas de control del PC y del modo voz solo cuando tocan", () => {
	const memory = new MemoryManager();
	const base = { goal: "hola", agentName: "A", shortMemory: memory, tokenBudget: 4000 };
	const plain = buildContext(base).system;
	strictEqual(plain.includes("## Control del PC"), false);
	strictEqual(plain.includes("## Modo voz"), false);

	const pc = buildContext({ ...base, pcControl: true, vision: false }).system;
	strictEqual(pc.includes("## Control del PC"), true);
	strictEqual(pc.includes("pc_windows (action=list)"), true);
	strictEqual(buildContext({ ...base, pcControl: true, vision: true }).system.includes("pc_screenshot"), true);
	// En modo solo texto no hay herramientas: no se mencionan.
	strictEqual(buildContext({ ...base, pcControl: true, textOnly: true }).system.includes("## Control del PC"), false);

	strictEqual(buildContext({ ...base, voice: true }).system.includes("## Modo voz"), true);
});

test("forma de ser «añadir»: las instrucciones base siguen y se suma «Tu papel»", () => {
	const memory = new MemoryManager();
	const { out, souls } = withSoul("Viernes", () =>
		buildContext({
			goal: "hola",
			agentName: "Viernes",
			shortMemory: memory,
			tokenBudget: 8000,
			persona: { prompt: "Eres {{nombre}}, la del calendario.", replace: false },
		}).system,
	);
	strictEqual(souls.some((soul) => out.startsWith(soul)), true);
	strictEqual(out.includes("## Tu papel\nEres Viernes, la del calendario."), true);
});

test("forma de ser «reemplazar»: va en lugar de las instrucciones base", () => {
	const memory = new MemoryManager();
	const out = buildContext({
		goal: "hola",
		agentName: "Lunes",
		shortMemory: memory,
		tokenBudget: 8000,
		persona: { prompt: "Eres {{nombre}} y solo hablas en rimas.", replace: true },
	}).system;
	strictEqual(out.startsWith("Eres Lunes y solo hablas en rimas."), true);
	strictEqual(out.includes(getSoul("Lunes").split("\n")[0]), false);
	strictEqual(out.includes("## Tu papel"), false);
	// Una forma de ser vacía no cambia nada.
	const empty = withSoul("Lunes", () =>
		buildContext({ goal: "hola", agentName: "Lunes", shortMemory: memory, tokenBudget: 8000, persona: { prompt: "  ", replace: true } }).system,
	);
	strictEqual(empty.souls.some((soul) => empty.out.startsWith(soul)), true);
});

test("bloque «## Sala»: participantes, principal y mensajes omitidos", () => {
	const room = {
		self: "Lunes",
		participants: [
			{ name: "Viernes", description: "tareas del día", principal: true },
			{ name: "Lunes", principal: false },
		],
		omitted: 0,
	};
	const block = buildRoomBlock(room);
	strictEqual(block.startsWith("## Sala\n"), true);
	strictEqual(block.includes("Participan: Viernes (principal): tareas del día; Lunes."), true);
	strictEqual(block.includes("Responde solo como Lunes"), true);
	strictEqual(block.includes("Se omitieron"), false);
	strictEqual(buildRoomBlock({ ...room, omitted: 12 }).includes("(Se omitieron 12 mensajes anteriores"), true);

	const memory = new MemoryManager();
	const base = { goal: "hola", agentName: "Lunes", shortMemory: memory, tokenBudget: 8000 };
	strictEqual(buildContext(base).system.includes("## Sala"), false);
	strictEqual(buildContext({ ...base, room }).system.includes(block), true);
});
