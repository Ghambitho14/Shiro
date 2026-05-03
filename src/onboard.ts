import { input, confirm, select } from "@inquirer/prompts";
import { getState, setState } from "./store.js";
import { getConfig, setConfig } from "./config/config.js";

const ASSISTANT_NAME = "Shiro";
const DEFAULT_VLLM = "http://127.0.0.1:8000/v1";
const DEFAULT_MODEL = "default";

const PROVIDER_OPTIONS = [
	{ name: "vLLM (local)", value: "vllm" },
	{ name: "Ollama (local)", value: "ollama" },
	{ name: "OpenRouter (externo)", value: "openrouter" },
	{ name: "OpenCode (externo)", value: "opencode" },
] as const;

export async function runOnboard(): Promise<void> {
	console.log("\n  ═══ Configuración inicial — Shiro ═══\n");
	console.log("  El asistente se llama Shiro. Responde paso a paso (Enter = por defecto).\n");

	setState({ name: ASSISTANT_NAME });

	const provider = await select({
		message: "Selecciona el proveedor de LLM:",
		choices: PROVIDER_OPTIONS as unknown as { name: string; value: string }[],
		default: getConfig().llmProvider ?? "opencode",
	});

	setConfig({ llmProvider: provider as "vllm" | "ollama" | "openrouter" | "opencode" });
	console.log(`  → Provider: ${provider}\n`);

	if (provider === "vllm") {
		const vllmBaseUrl = await input({
			message: "URL base de vLLM",
			default: getConfig().vllmBaseUrl ?? DEFAULT_VLLM,
		});
		if (vllmBaseUrl.trim()) {
			setConfig({ vllmBaseUrl: vllmBaseUrl.trim().replace(/\/+$/, "") });
			console.log("  → Guardado.\n");
		}

		const model = await input({
			message: "Modelo (ej. default o meta-llama/Llama-3.2-3B)",
			default: getConfig().model ?? DEFAULT_MODEL,
		});
		if (model.trim()) {
			setConfig({ model: model.trim() });
			console.log("  → Guardado.\n");
		}
	}

	if (provider === "ollama") {
		const ollamaBaseUrl = await input({
			message: "URL base de Ollama",
			default: getConfig().ollamaBaseUrl ?? "http://localhost:11434",
		});
		if (ollamaBaseUrl.trim()) {
			setConfig({ ollamaBaseUrl: ollamaBaseUrl.trim().replace(/\/+$/, "") });
			console.log("  → Guardado.\n");
		}

		const ollamaModel = await input({
			message: "Modelo Ollama (ej. llama3.2)",
			default: getConfig().ollamaModel ?? "llama3.2",
		});
		if (ollamaModel.trim()) {
			setConfig({ ollamaModel: ollamaModel.trim() });
			console.log("  → Guardado.\n");
		}
	}

	if (provider === "openrouter") {
		const openrouterModel = await input({
			message: "Modelo OpenRouter (ej. openai/gpt-4o-mini)",
			default: getConfig().openrouterModel ?? "openai/gpt-4o-mini",
		});
		if (openrouterModel.trim()) {
			setConfig({ openrouterModel: openrouterModel.trim() });
			console.log("  → Guardado.\n");
		}
		console.log("  → API Key: configurable en variable OPENROUTER_API_KEY o config.json\n");
	}

	if (provider === "opencode") {
		const opencodeModel = await input({
			message: "Modelo OpenCode (ej. kimi-k2.6)",
			default: getConfig().opencodeModel ?? "kimi-k2.6",
		});
		if (opencodeModel.trim()) {
			setConfig({ opencodeModel: opencodeModel.trim() });
			console.log("  → Guardado.\n");
		}
		console.log("  → API Key: configurable en variable OPENCODE_API_KEY o config.json\n");
	}

	// 4. Habilidades (opcional)
	const abilities = await input({
		message: "Habilidades o instrucciones extra (opcional, Enter para omitir)",
		default: getConfig().abilities ?? "",
	});
	setConfig({ abilities: abilities.trim() || undefined });
	if (abilities.trim()) console.log("  → Guardado.\n");

	// Modo autónomo (herramientas)
	const autonomous = await confirm({
		message: "¿Activar modo autónomo (herramientas)? Sí recomendado.",
		default: getConfig().autonomousMode !== false,
	});
	setConfig({ autonomousMode: autonomous });
	console.log("  → Modo autónomo:", autonomous ? "activado" : "desactivado (solo chat)\n");

	// Explicación de tools
	const explain = await input({
		message: "¿Cómo quieres que Shiro explique el uso de herramientas? (off|brief|on)",
		default: (getConfig().explainMode ?? "off"),
	});
	setConfig({ explainMode: (explain.trim() === "off" || explain.trim() === "on" || explain.trim() === "brief") ? (explain.trim() as "off" | "brief" | "on") : "brief" });
	console.log("  → explainMode:", getConfig().explainMode, "\n");

	// Resumen
	const cfg = getConfig();
	console.log("  --- Resumen ---");
	console.log(`  Asistente:  Shiro (fijo)`);
	console.log(`  Provider:   ${cfg.llmProvider}`);
	if (cfg.llmProvider === "vllm") {
		console.log(`  URL:        ${cfg.vllmBaseUrl}`);
		console.log(`  Modelo:     ${cfg.model}`);
	}
	if (cfg.llmProvider === "ollama") {
		console.log(`  URL:        ${cfg.ollamaBaseUrl}`);
		console.log(`  Modelo:     ${cfg.ollamaModel}`);
	}
	if (cfg.llmProvider === "openrouter") {
		console.log(`  Modelo:     ${cfg.openrouterModel}`);
		console.log(`  API Key:    ${cfg.openrouterApiKey ? "configurada" : "falta"}`);
	}
	if (cfg.llmProvider === "opencode") {
		console.log(`  Modelo:     ${cfg.opencodeModel}`);
		console.log(`  API Key:    ${cfg.opencodeApiKey || process.env.OPENCODE_API_KEY ? "configurada" : "falta (configurar en .env)"}`);
	}
	console.log(`  Modo autónomo: ${(cfg.autonomousMode !== false) ? "sí" : "no"}`);
	console.log(`  Explain tools: ${cfg.explainMode ?? "brief"}`);
	console.log(`  Habilidades: ${cfg.abilities ? "(definidas)" : "(ninguna)"}`);
	console.log("  -------------\n");

	const wantPersonalize = await confirm({
		message: "¿Quieres que Shiro sepa algo sobre ti? (nombre, idioma, aficiones...)",
		default: true,
	});
	if (wantPersonalize) {
		const { runPersonalize } = await import("./personalize.js");
		await runPersonalize();
	}

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
