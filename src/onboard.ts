import { input, confirm } from "@inquirer/prompts";
import { getState, setState } from "./store.js";
import { getConfig, setConfig } from "./config/config.js";
import { runModelSetup } from "./modelSetup.js";
import { PROVIDER_PRESETS, resolveLLMSettings } from "./core/llm/providers.js";

const ASSISTANT_NAME = "Shiro";

export async function runOnboard(): Promise<void> {
	console.log("\n  ═══ Configuración inicial — Shiro ═══\n");
	console.log("  El asistente se llama Shiro. Responde paso a paso (Enter = por defecto).\n");

	setState({ name: ASSISTANT_NAME });

	await runModelSetup();

	// Habilidades (opcional)
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
	const llm = resolveLLMSettings();
	console.log(`  Modelo:     ${llm.model} (${PROVIDER_PRESETS[llm.provider].label})`);
	console.log(`  URL:        ${llm.baseUrl}`);
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
		console.log("    npm run dev    → web de chat");
		console.log("    npm run tui    → chat en terminal");
		console.log("    npm run config → volver a configurar\n");
	}
}
