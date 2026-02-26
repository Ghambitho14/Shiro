import { input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { buildWorkspaceContext } from "./workspace.js";
import { vllmClient } from "./core/llm/vllmClient.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";

export async function runTuiChat(): Promise<void> {
	const state = getState();
	const memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	const workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true });

	console.log(`\n  ${state.name} — Chat en terminal. Escribe "salir" o "exit" para terminar.\n`);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const userMessage = await input({ message: "Tú:" });
		const trimmed = userMessage?.trim() ?? "";
		if (!trimmed) continue;
		const msg = trimmed.toLowerCase();
		if (msg === "salir" || msg === "exit") {
			console.log("\n  Hasta luego.\n");
			break;
		}
		try {
			const response = await runAgent(trimmed, {
				llm: vllmClient,
				memory,
				agentName: state.name,
				tokenBudget: 8000,
				usePlanner: false,
			}, workspaceContext ?? undefined);
			console.log(`\n  ${state.name}: ${response}\n`);
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			console.error(`\n  Error: ${text}\n`);
		}
	}
}
