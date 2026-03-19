import { input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import { getToolsDefinition } from "./core/tools/ToolRegistry.js";

const C = {
	black: "\x1b[30m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	white: "\x1b[37m",
	gray: "\x1b[90m",
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
};

function box(content: string, title?: string, width = 60): string {
	const lines = content.split("\n");
	const maxLen = Math.max(...lines.map(l => l.length), title?.length || 0, width);
	const w = Math.min(maxLen, width);
	
	let result = "";
	if (title) {
		const pad = w - title.length;
		const left = Math.floor(pad / 2);
		const right = pad - left;
		result += "┌" + "─".repeat(left) + " " + title + " " + "─".repeat(right) + "┐\n";
	} else {
		result += "┌" + "─".repeat(w + 2) + "┐\n";
	}
	
	for (const line of lines) {
		const pad = w - line.length;
		result += "│ " + line + " ".repeat(pad + 1) + "│\n";
	}
	
	result += "└" + "─".repeat(w + 2) + "┘";
	return result;
}

function printHeader(name: string): void {
	console.log(`
${C.cyan}╔══════════════════════════════════════════════════════════════╗
║  ${C.bold}${name}${C.reset}${C.cyan} — Asistente de IA personal                        ║
║  ${C.dim}Versión 0.2.0 | Modo Autónomo                                ${C.cyan}║
╚══════════════════════════════════════════════════════════════╝${C.reset}
`);
}

function printHelp(): void {
	const helpText = `
${C.yellow}COMANDOS:${C.reset}
  ${C.green}/ayuda${C.reset}      - Mostrar esta ayuda
  ${C.green}/status${C.reset}    - Ver estado del sistema
  ${C.green}/herramientas${C.reset} - Listar herramientas disponibles
  ${C.green}/historial${C.reset} - Ver historial de conversación
  ${C.green}/clear${C.reset}     - Limpiar pantalla
  ${C.green}/salir${C.reset}     - Salir del chat

${C.yellow}TIPS:${C.reset}
  • Escribe normalmente, Shiro te entiende
  • Puedes pedirle que analice proyectos
  • Puede auto-modificar su propio código
  • Antes de actuar, te preguntará para qué
`;
	console.log(box(helpText, " AYUDA ", 65));
}

function printStatus(): void {
	const config = getConfig();
	const llm = getLLM();
	const llmConfig = llm.getConfig();
	
	const statusText = `
${C.cyan}Proveedor:${C.reset} ${config.llmProvider || "vllm"}
${C.cyan}Modelo:${C.reset} ${llmConfig.model || "default"}
${C.cyan}URL:${C.reset} ${llmConfig.baseUrl}
${C.cyan}Modo:${C.reset} ${config.autonomousMode ? C.green + "Autónomo" + C.reset : C.yellow + "Solo texto" + C.reset}
`;
	console.log(box(statusText, " STATUS ", 65));
}

function printTools(): void {
	const tools = getToolsDefinition(true);
	const categories: Record<string, string[]> = {};
	
	for (const tool of tools) {
		const name = tool.function.name;
		const cat = name.split("_")[0] || "otro";
		if (!categories[cat]) categories[cat] = [];
		categories[cat].push(name);
	}
	
	let output = "";
	for (const [cat, names] of Object.entries(categories)) {
		output += `${C.cyan}[${cat}]${C.reset}\n`;
		for (const n of names) {
			output += `  ${C.green}•${C.reset} ${n}\n`;
		}
		output += "\n";
	}
	console.log(box(output, " HERRAMIENTAS ", 65));
}

function printHistory(history: Array<{role: string, content: string}>): void {
	if (history.length === 0) {
		console.log(box(" No hay mensajes en el historial ", " HISTORIAL ", 60));
		return;
	}
	
	let output = "";
	const show = history.slice(-10);
	for (const msg of show) {
		const prefix = msg.role === "user" ? C.red + "Tú" : C.cyan + "Shiro";
		const content = msg.content.slice(0, 80) + (msg.content.length > 80 ? "..." : "");
		output += `${prefix}${C.reset}: ${content}\n`;
	}
	console.log(box(output, ` HISTORIAL (últimos ${show.length}) `, 70));
}

function isPromptCancelled(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const withName = err as { name?: unknown; message?: unknown };
	return withName.name === "ExitPromptError"
		|| (typeof withName.message === "string" && withName.message.toLowerCase().includes("force closed"));
}

async function checkLlmConnection(): Promise<boolean> {
	try {
		const llm = getLLM();
		const config = llm.getConfig();
		console.log(`  ${C.gray}Conectando a ${config.baseUrl}...${C.reset}`);
		
		const response = await fetch(config.baseUrl + "/models", {
			method: "GET",
			headers: config.model ? { "Authorization": `Bearer ${config.model}` } : {}
		});
		
		if (response.ok) {
			console.log(`  ${C.green}✓${C.reset} Conectado (modelo: ${config.model})`);
			return true;
		} else {
			console.log(`  ${C.red}✗${C.reset} Error: ${response.status}`);
			return false;
		}
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		console.log(`  ${C.red}✗${C.reset} No conectado: ${text}`);
		return false;
	}
}

function printWelcome(name: string): void {
	const welcome = `
${C.bold}¡Hola! Soy ${name}.${C.reset}
Puedo ayudarte con:
  • Programar y analizar código
  • Trabajar con archivos y proyectos
  • Ejecutar comandos en tu PC
  • Auto-modificar mi propio código
  • Y mucho más...

${C.yellow}Escribe ${C.bold}/ayuda${C.reset}${C.yellow} para ver todos los comandos.${C.reset}

${C.dim}Antes de actuar, te preguntaré para qué lo necesitas.${C.reset}
`;
	console.log(box(welcome, ` BIENVENIDO `, 65));
}

export async function runTuiChat(): Promise<void> {
	const state = getState();
	const config = getConfig();
	const autonomous = config.autonomousMode !== false;
	const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });
	
	const history: Array<{role: string, content: string}> = [];
	
	console.clear();
	printHeader(state.name);
	
	console.log("\n  Verificando conexión con LLM...");
	const connected = await checkLlmConnection();
	if (!connected) {
		console.log(`\n  ${C.yellow}⚠️${C.reset} Advertencia: Sin conexión con LLM.`);
		console.log("  El chat puede no funcionar correctamente.");
		const continuar = await input({ 
			message: "  ¿Continuar? (s/n): ",
			default: "n"
		});
		if (continuar.trim().toLowerCase() !== "s") {
			console.log("  Chat cancelado.\n");
			return;
		}
	}
	
	printWelcome(state.name);
	
	while (true) {
		let userMessage = "";
		try {
			userMessage = await input({ 
				message: `\n${C.red}➤${C.reset} `,
			});
		} catch (err) {
			if (isPromptCancelled(err)) {
				console.log(`\n  ${C.gray}Chao${C.reset}\n`);
				break;
			}
			throw err;
		}
		
		const trimmed = userMessage?.trim() ?? "";
		if (!trimmed) continue;
		
		const cmd = trimmed.toLowerCase();
		
		if (cmd === "/salir" || cmd === "/exit" || cmd === "salir" || cmd === "exit") {
			console.log(`\n  ${C.cyan}¡Hasta luego! 👋${C.reset}\n`);
			break;
		}
		
		if (cmd === "/ayuda" || cmd === "/help") {
			printHelp();
			continue;
		}
		
		if (cmd === "/status") {
			printStatus();
			continue;
		}
		
		if (cmd === "/herramientas" || cmd === "/tools") {
			printTools();
			continue;
		}
		
		if (cmd === "/historial" || cmd === "/history") {
			printHistory(history);
			continue;
		}
		
		if (cmd === "/clear" || cmd === "clear") {
			console.clear();
			printHeader(state.name);
			continue;
		}
		
		history.push({ role: "user", content: trimmed });
		
		try {
			console.log(`\n  ${C.gray}🤔 Pensando...${C.reset}`);
			
			const response = await runAgent(trimmed, {
				llm: getLLM(),
				memory,
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: autonomous,
				textOnly: !autonomous,
				userProfile: getUserProfile(),
			}, workspaceContext ?? undefined);
			
			history.push({ role: "assistant", content: response });
			
			if (!response || response.trim() === "") {
				console.log(`\n  ${C.cyan}${state.name}:${C.reset} (sin respuesta)\n`);
			} else {
				console.log(`\n  ${C.cyan}${state.name}:${C.reset} ${response}\n`);
			}
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			console.error(`\n  ${C.red}❌ Error:${C.reset} ${text}\n`);
			
			if (text.includes("fetch") || text.includes("ECONNREFUSED")) {
				console.log("  ⚠️  LLM no disponible.");
				const retry = await input({ message: "  ¿Reintentar? (s/n): ", default: "s" });
				if (retry.trim().toLowerCase() !== "s") {
					console.log("\n  Chat terminado.\n");
					break;
				}
			}
		}
	}
}