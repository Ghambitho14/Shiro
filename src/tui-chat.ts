import { input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { vllmClient } from "./core/llm/vllmClient.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";

function isPromptCancelled(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const withName = err as { name?: unknown; message?: unknown };
	return withName.name === "ExitPromptError"
		|| (typeof withName.message === "string" && withName.message.toLowerCase().includes("force closed"));
}

export async function runTuiChat(): Promise<void> {
	const state = getState();
	const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });

	console.log(`\n  ${state.name} — Chat en terminal. Escribe "salir" o "exit" para terminar.\n`);

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
			const config = getConfig();
			const autonomous = config.autonomousMode !== false;
			const response = await runAgent(trimmed, {
				llm: vllmClient,
				memory,
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: autonomous,
				textOnly: !autonomous,
				userProfile: getUserProfile(),
			}, workspaceContext ?? undefined);
			console.log(`\n  ${state.name}: ${response}\n`);
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			console.error(`\n  Error: ${text}\n`);
		}
	}
}
