import { input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import { getToolsDefinition } from "./core/tools/ToolRegistry.js";

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
		console.log(`  Conectando a ${config.baseUrl}...`);
		
		const response = await fetch(config.baseUrl + "/models", {
			method: "GET",
			headers: config.model ? { "Authorization": `Bearer ${config.model}` } : {}
		});
		
		if (response.ok) {
			console.log(`  ✓ Conectado (modelo: ${config.model})`);
			return true;
		} else {
			console.log(`  ✗ Error de conexión: ${response.status}`);
			return false;
		}
	} catch (err) {
		const text = err instanceof Error ? err.message : String(err);
		console.log(`  ✗ No se pudo conectar: ${text}`);
		return false;
	}
}

function showAvailableTools(): void {
	const tools = getToolsDefinition(true);
	console.log("\n  📦 Herramientas disponibles:");
	for (const tool of tools) {
		const desc = tool.function.description || "Sin descripción";
		console.log(`    • ${tool.function.name}: ${desc.slice(0, 60)}...`);
	}
	console.log("");
}

export async function runTuiChat(): Promise<void> {
	const state = getState();
	const config = getConfig();
	const autonomous = config.autonomousMode !== false;
	const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });

	console.log(`\n  ${state.name} — Chat en terminal.`);
	console.log(`  Modo: ${autonomous ? "autónomo (herramientas + planner)" : "solo texto"}`);
	console.log(`  Escribe "salir" o "exit" para terminar.\n`);

	console.log("  Verificando conexión con vLLM...");
	const connected = await checkLlmConnection();
	if (!connected) {
		console.log("\n  ⚠️  ADVERTENCIA: No hay conexión con vLLM.");
		console.log("  El chat puede no funcionar correctamente.");
		const continuar = await input({ 
			message: "  ¿Continuar de todas formas? (s/n): ",
			default: "n"
		});
		if (continuar.trim().toLowerCase() !== "s") {
			console.log("  Chat cancelado.\n");
			return;
		}
	}

	showAvailableTools();

	// eslint-disable-next-line no-constant-condition
	while (true) {
		let userMessage = "";
		try {
			userMessage = await input({ message: "Tú:" });
		} catch (err) {
			if (isPromptCancelled(err)) {
				console.log("\n  Detecté Ctrl+C. Cerrando chat...\n");
				break;
			}
			throw err;
		}
		const trimmed = userMessage?.trim() ?? "";
		if (!trimmed) continue;
		const msg = trimmed.toLowerCase();
		if (msg === "salir" || msg === "exit") {
			console.log("\n  Hasta luego.\n");
			break;
		}
		try {
			const response = await runAgent(trimmed, {
				llm: getLLM(),
				memory,
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: autonomous,
				textOnly: !autonomous,
				userProfile: getUserProfile(),
			}, workspaceContext ?? undefined);
			
			if (!response || response.trim() === "") {
				console.log(`\n  ${state.name}: (sin respuesta)\n`);
			} else {
				console.log(`\n  ${state.name}: ${response}\n`);
			}
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			console.error(`\n  ❌ Error: ${text}\n`);
			
			if (text.includes("fetch") || text.includes("ECONNREFUSED") || text.includes("network")) {
				console.log("  ⚠️  Parece que vLLM no está disponible.");
				console.log("  ¿Quieres seguir intentando o salir? (s/n)");
				const retry = await input({ message: "  > ", default: "s" });
				if (retry.trim().toLowerCase() !== "s") {
					console.log("\n  Chat terminado.\n");
					break;
				}
			}
		}
	}
}
