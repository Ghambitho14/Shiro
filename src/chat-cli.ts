/**
 * Chat en la terminal (`npm run tui`): simple, con streaming y aprobación de acciones.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { PROVIDER_PRESETS } from "./core/llm/providers.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import { setLogLevel } from "./core/logger.js";
import type { Approver } from "./core/tools/approval.js";
import { mcpManager } from "./core/mcp/McpManager.js";
import { matchSkillCommand, parseCommand, plainText } from "./commands.js";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

/** Comandos que solo existen en la terminal; el resto son los mismos que en la web (commands.ts). */
const TERMINAL_HELP = `
  /doctor   Comprueba que el modelo funciona
  /salir    Cierra el chat
`;

export async function runChat(): Promise<void> {
	// Los logs de info ensucian el chat; solo avisos y errores.
	setLogLevel("warn");
	const name = getState().name;
	const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true }) || undefined;
	const history: { role: "user" | "assistant"; content: string }[] = [];
	const rl = createInterface({ input: stdin, output: stdout });

	// Cola de líneas: no se pierde lo que el usuario escribe mientras Shiro responde.
	const pending: string[] = [];
	const waiters: ((line: string | null) => void)[] = [];
	let closed = false;
	rl.on("line", (line) => {
		const w = waiters.shift();
		if (w) w(line);
		else pending.push(line);
	});
	rl.on("close", () => {
		closed = true;
		for (const w of waiters.splice(0)) w(null);
	});
	const ask = (prompt: string): Promise<string | null> => {
		stdout.write(prompt);
		if (pending.length) return Promise.resolve(pending.shift()!);
		if (closed) return Promise.resolve(null);
		return new Promise((resolve) => waiters.push(resolve));
	};

	const approver: Approver = async ({ summary }) => {
		stdout.write(`\n${C.yellow}⚠ ${name} quiere: ${summary}${C.reset}\n`);
		const answer = ((await ask(`${C.yellow}¿Permitir? (s/n) ${C.reset}`)) ?? "").trim().toLowerCase();
		const approved = answer === "s" || answer === "si" || answer === "sí" || answer === "y" || answer === "yes";
		stdout.write(approved ? `${C.green}✓ Permitido${C.reset}\n` : `${C.red}✗ Rechazado${C.reset}\n`);
		return approved;
	};

	// Servidores MCP de Ajustes → Conectores MCP (sus herramientas aparecen cuando terminan de arrancar).
	mcpManager.start();
	const llm = getLLM().getConfig();
	stdout.write(`\n${C.cyan}${name}${C.reset} ${C.dim}— ${llm.model} (${PROVIDER_PRESETS[llm.provider as keyof typeof PROVIDER_PRESETS]?.label ?? llm.provider})${C.reset}\n`);
	stdout.write(`${C.dim}Escribe /ayuda para ver los comandos. Ctrl+C para salir.${C.reset}\n\n`);

	rl.on("SIGINT", () => {
		stdout.write("\nHasta luego.\n");
		process.exit(0);
	});

	while (true) {
		const line = await ask(`${C.green}tú ›${C.reset} `);
		if (line === null) break; // stdin cerrado
		const text = line.trim();
		if (!text) continue;

		if (text.startsWith("/")) {
			const word = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? "";
			if (word === "salir" || word === "exit") break;
			if (word === "doctor") {
				const { runDoctor } = await import("./doctor.js");
				await runDoctor();
				continue;
			}
			if (["nuevo", "new", "limpiar", "clear", "reset"].includes(word)) {
				history.length = 0;
				stdout.write(`${C.dim}Conversación olvidada. Empezamos de nuevo.${C.reset}\n\n`);
				continue;
			}
			const result = parseCommand(text);
			if (result?.executed) {
				stdout.write(`${plainText(result.content)}\n${word === "ayuda" || word === "help" ? TERMINAL_HELP : ""}\n`);
				continue;
			}
			// Si no es un comando, puede ser "/habilidad mensaje" o texto normal: sigue abajo.
		}

		history.push({ role: "user", content: text });
		stdout.write(`${C.cyan}${name} ›${C.reset} `);
		let streamed = false;
		const cfg = getConfig();
		const response = await runAgent(
			text,
			{
				llm: getLLM(),
				memory,
				agentName: name,
				textOnly: cfg.autonomousMode === false,
				explainMode: cfg.explainMode,
				userProfile: getUserProfile(),
				conversation: history.slice(-20),
				approver,
				skill: matchSkillCommand(text)?.skill,
				onStreamDelta: (chunk) => {
					streamed = true;
					stdout.write(chunk);
				},
			},
			workspaceContext,
		);
		// Si no hubo streaming (o terminó en error), mostrar la respuesta completa.
		if (!streamed || response.startsWith("⚠️")) stdout.write(streamed ? `\n${response}` : response);
		stdout.write("\n\n");
		history.push({ role: "assistant", content: response });
	}

	rl.close();
	await mcpManager.closeAll();
	stdout.write("Hasta luego.\n");
}
