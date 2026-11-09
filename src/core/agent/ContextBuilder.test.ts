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
const { getSoul } = await import("../soul/soul.js");

/** Las instrucciones base llevan la hora: se calculan antes y después por si cambia el minuto. */
function withSoul(agentName: string, build: () => string): { out: string; souls: string[] } {
	const before = getSoul(agentName);
	const out = build();
	return { out, souls: [before, getSoul(agentName)] };
}

test("buildContext respects token budget and includes soul", () => {
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
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

test("el system prompt no repite la conversación (va aparte, como mensajes)", () => {
	const { system } = buildContext({ goal: "Continue", agentName: "A", tokenBudget: 4000 });
	strictEqual(/Eventos recientes|Memoria a largo plazo/.test(system), false);
});

test("buildContext: el resumen de «Cerrar conversación» va en el system prompt y cuenta como memoria", () => {
	const without = buildContext({ goal: "sigue", agentName: "A", tokenBudget: 4000 });
	strictEqual(without.system.includes("Lo que ya se habló en este chat"), false);
	const withSummary = buildContext({ goal: "sigue", agentName: "A", tokenBudget: 4000, chatSummary: "- Jhon usa LM Studio." });
	strictEqual(withSummary.system.includes("## Lo que ya se habló en este chat"), true);
	strictEqual(withSummary.system.includes("- Jhon usa LM Studio."), true);
	strictEqual(withSummary.sections.memory > without.sections.memory, true);
});

test("buildContext no duplica el manifiesto de tools (van por la API)", () => {
	const out = buildContext({
		goal: "List files",
		agentName: "TestAgent",
		tokenBudget: 2000,
	});

	strictEqual(out.system.includes("## Herramientas disponibles"), false);
});

test("buildContext añade las reglas de control del PC y del modo voz solo cuando tocan", () => {
	const base = { goal: "hola", agentName: "A", tokenBudget: 4000 };
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
	const { out, souls } = withSoul("Viernes", () =>
		buildContext({
			goal: "hola",
			agentName: "Viernes",
			tokenBudget: 8000,
			persona: { prompt: "Eres {{nombre}}, la del calendario.", replace: false },
		}).system,
	);
	strictEqual(souls.some((soul) => out.startsWith(soul)), true);
	strictEqual(out.includes("## Tu papel\nEres Viernes, la del calendario."), true);
});

test("forma de ser «reemplazar»: va en lugar de las instrucciones base", () => {
	const out = buildContext({
		goal: "hola",
		agentName: "Lunes",
		tokenBudget: 8000,
		persona: { prompt: "Eres {{nombre}} y solo hablas en rimas.", replace: true },
	}).system;
	strictEqual(out.startsWith("Eres Lunes y solo hablas en rimas."), true);
	strictEqual(out.includes(getSoul("Lunes").split("\n")[0]), false);
	strictEqual(out.includes("## Tu papel"), false);
	// Una forma de ser vacía no cambia nada.
	const empty = withSoul("Lunes", () =>
		buildContext({ goal: "hola", agentName: "Lunes", tokenBudget: 8000, persona: { prompt: "  ", replace: true } }).system,
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

	const base = { goal: "hola", agentName: "Lunes", tokenBudget: 8000 };
	strictEqual(buildContext(base).system.includes("## Sala"), false);
	strictEqual(buildContext({ ...base, room }).system.includes(block), true);
});

test("modo CodeHacking: incluye el bloque de pentesting y el guardarraíl de alcance", () => {
	const { system } = buildContext({ goal: "Escanea mi VPS", agentName: "Shiro", tokenBudget: 4000, mode: "hacking" });
	strictEqual(system.includes("Modo CodeHacking"), true);
	// Guardarraíl: solo objetivos autorizados.
	strictEqual(/autorizad/i.test(system), true);
	strictEqual(system.includes("cve_search"), true);
});

test("sin hacking no aparece el bloque de pentesting", () => {
	const { system } = buildContext({ goal: "Hola", agentName: "Shiro", tokenBudget: 4000 });
	strictEqual(system.includes("Modo CodeHacking"), false);
});

test("en modo texto (sin herramientas) no se añade el bloque de pentesting", () => {
	const { system } = buildContext({ goal: "Hola", agentName: "Shiro", tokenBudget: 4000, mode: "hacking", textOnly: true });
	strictEqual(system.includes("Modo CodeHacking"), false);
});

test("planear explica el solo lectura incluso si no hay herramientas", () => {
	const { system } = buildContext({ goal: "Haz un plan", agentName: "Shiro", tokenBudget: 4000, planning: true, textOnly: true });
	strictEqual(system.includes("Planear (solo lectura)"), true);
	strictEqual(system.includes("No implementes el plan"), true);
	strictEqual(system.includes("«Preguntar» o «Automático»"), true);
});

test("planear en CodeHacking no dice que puede cambiar cosas, pero conserva el alcance y la metodología", () => {
	const { system } = buildContext({ goal: "Haz un plan", agentName: "Shiro", tokenBudget: 4000, mode: "hacking", planning: true });
	strictEqual(system.includes("Planear (solo lectura)"), true);
	strictEqual(system.includes("Modo CodeHacking"), false);
	strictEqual(system.includes("Planear en CodeHacking"), true);
	strictEqual(system.includes("confirma que el objetivo"), true);
	strictEqual(system.includes("Metodología"), true);
});

test("planear en Chat no añade nada de pentesting", () => {
	const { system } = buildContext({ goal: "Haz un plan", agentName: "Shiro", tokenBudget: 4000, mode: "chat", planning: true });
	strictEqual(system.includes("Planear (solo lectura)"), true);
	strictEqual(system.includes("Planear en CodeHacking"), false);
});

test("CodeHacking pide leer antes de cambiar y comprobar el resultado", () => {
	const { system } = buildContext({ goal: "Arregla el fallo", agentName: "Shiro", tokenBudget: 4000, mode: "hacking" });
	strictEqual(system.includes("Modo CodeHacking"), true);
	strictEqual(system.includes("Antes de cambiar algo"), true);
	strictEqual(system.includes("Nunca digas que algo funciona"), true);
});
