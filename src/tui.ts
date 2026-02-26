import { select, input, confirm } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getConfig, setConfig, resetConfig } from "./config.js";

const MENU_OPTIONS = [
	{ name: "Iniciar web de chat (servidor + vLLM)", value: "web" },
	{ name: "Ver configuración", value: "list" },
	{ name: "Establecer modelo (vLLM)", value: "model" },
	{ name: "Establecer URL base vLLM", value: "vllm-base" },
	{ name: "Establecer habilidades del asistente", value: "abilities" },
	{ name: "Cambiar nombre del asistente", value: "name" },
	{ name: "Resetear todo (config + nombre)", value: "reset" },
	{ name: "Salir", value: "exit" },
] as const;

export async function runTui(): Promise<void> {
	const name = getState().name;
	console.log(`\n  PiClaw — ${name}\n  Usa las flechas para moverte, Enter para elegir.\n`);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const choice = await select({
			message: "¿Qué quieres hacer?",
			choices: MENU_OPTIONS as unknown as { name: string; value: string }[],
			pageSize: 10,
		});

		switch (choice) {
			case "web":
				await import("./server.js");
				return;
			case "list": {
				const cfg = getConfig();
				console.log("\n--- Configuración actual ---");
				console.log("  model:", cfg.model ?? "(por defecto)");
				console.log("  vllm-base:", cfg.vllmBaseUrl ?? "(por defecto)");
				console.log("  vllm-api-key:", cfg.vllmApiKey ? "***" : "(no definida)");
				console.log("  abilities:", cfg.abilities ?? "(ninguna)");
				console.log("  nombre:", getState().name);
				console.log("----------------------------\n");
				break;
			}
			case "model": {
				const value = await input({
					message: "Modelo vLLM (ej. default o meta-llama/Llama-3.2-3B)",
					default: getConfig().model ?? "default",
				});
				if (value.trim()) {
					setConfig({ model: value.trim() });
					console.log("  Modelo guardado.\n");
				}
				break;
			}
			case "vllm-base": {
				const value = await input({
					message: "URL base vLLM",
					default: getConfig().vllmBaseUrl ?? "http://127.0.0.1:8000/v1",
				});
				if (value.trim()) {
					setConfig({ vllmBaseUrl: value.trim() });
					console.log("  URL guardada.\n");
				}
				break;
			}
			case "abilities": {
				const value = await input({
					message: "Habilidades o instrucciones (texto libre)",
					default: getConfig().abilities ?? "",
				});
				setConfig({ abilities: value.trim() || undefined });
				console.log("  Habilidades guardadas.\n");
				break;
			}
			case "name": {
				const { setState } = await import("./store.js");
				const value = await input({
					message: "Nombre del asistente",
					default: getState().name,
				});
				if (value.trim()) {
					setState({ name: value.trim() });
					console.log("  Nombre guardado.\n");
				}
				break;
			}
			case "reset": {
				const ok = await confirm({
					message: "¿Resetear config y nombre? (vuelve a valores por defecto)",
					default: false,
				});
				if (ok) {
					await resetConfig(true);
					console.log("  Todo reseteado.\n");
				}
				break;
			}
			case "exit":
				console.log("  Hasta luego.\n");
				process.exit(0);
		}
	}
}
