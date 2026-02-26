import { input, confirm } from "@inquirer/prompts";
import { getState, setState } from "./store.js";
import { getConfig, setConfig } from "./config/config.js";

const DEFAULT_NAME = "Shiro";
const DEFAULT_VLLM = "http://127.0.0.1:8000/v1";
const DEFAULT_MODEL = "default";

export async function runOnboard(): Promise<void> {
	console.log("\n  ═══ Configuración inicial — Shiro ═══\n");
	console.log("  Responde paso a paso. Puedes dejar el valor por defecto con Enter.\n");

	// 1. Nombre del asistente
	const name = await input({
		message: "Nombre del asistente",
		default: getState().name || DEFAULT_NAME,
	});
	if (name.trim()) {
		setState({ name: name.trim() });
		console.log("  → Guardado.\n");
	}

	// 2. URL base vLLM
	const vllmBaseUrl = await input({
		message: "URL base de vLLM (donde corre el modelo)",
		default: getConfig().vllmBaseUrl ?? DEFAULT_VLLM,
	});
	if (vllmBaseUrl.trim()) {
		setConfig({ vllmBaseUrl: vllmBaseUrl.trim().replace(/\/+$/, "") });
		console.log("  → Guardado.\n");
	}

	// 3. Modelo
	const model = await input({
		message: "Modelo vLLM (ej. default o meta-llama/Llama-3.2-3B)",
		default: getConfig().model ?? DEFAULT_MODEL,
	});
	if (model.trim()) {
		setConfig({ model: model.trim() });
		console.log("  → Guardado.\n");
	}

	// 4. Habilidades (opcional)
	const abilities = await input({
		message: "Habilidades o instrucciones extra (opcional, Enter para omitir)",
		default: getConfig().abilities ?? "",
	});
	setConfig({ abilities: abilities.trim() || undefined });
	if (abilities.trim()) console.log("  → Guardado.\n");

	// Resumen
	const state = getState();
	const cfg = getConfig();
	console.log("  --- Resumen ---");
	console.log(`  Nombre:     ${state.name}`);
	console.log(`  vLLM URL:   ${cfg.vllmBaseUrl ?? DEFAULT_VLLM}`);
	console.log(`  Modelo:     ${cfg.model ?? DEFAULT_MODEL}`);
	console.log(`  Habilidades: ${cfg.abilities ? "(definidas)" : "(ninguna)"}`);
	console.log("  -------------\n");

	const startWeb = await confirm({
		message: "¿Iniciar la web de chat ahora?",
		default: true,
	});

	if (startWeb) {
		console.log("\n  Iniciando servidor...\n");
		await import("./server.js");
	} else {
		console.log("\n  Listo. Más adelante:");
		console.log("    pnpm run dev   → web de chat");
		console.log("    pnpm tui       → chat en terminal");
		console.log("    pnpm run config → volver a configurar\n");
	}
}
