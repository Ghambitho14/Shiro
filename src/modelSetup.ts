/** Asistente interactivo para elegir proveedor y modelo (usado por onboard y config). */
import { input, select, password, confirm } from "@inquirer/prompts";
import { getConfig, setConfig, LLM_PROVIDERS, type LLMProvider } from "./config/config.js";
import { PROVIDER_PRESETS, resolveLLMSettings } from "./core/llm/providers.js";
import { listModels, runDoctor } from "./doctor.js";

export async function runModelSetup(): Promise<void> {
	const current = getConfig();
	const provider = (await select({
		message: "¿Dónde corre el modelo?",
		choices: LLM_PROVIDERS.map((p) => ({ name: PROVIDER_PRESETS[p].label, value: p })),
		default: current.llmProvider,
	})) as LLMProvider;
	const preset = PROVIDER_PRESETS[provider];
	const sameProvider = provider === current.llmProvider;

	const baseUrl = await input({
		message: "URL del servidor (Enter = por defecto)",
		default: (sameProvider && current.llmBaseUrl) || preset.baseUrl,
	});

	let apiKey = sameProvider ? current.llmApiKey : undefined;
	if (preset.needsApiKey || provider === "custom" || provider === "vllm") {
		const envKey = preset.apiKeyEnv ? process.env[preset.apiKeyEnv] : undefined;
		const typed = await password({
			message: preset.needsApiKey
				? `API key${envKey ? ` (Enter = usar ${preset.apiKeyEnv})` : apiKey ? " (Enter = mantener la actual)" : ""}`
				: "API key (opcional, Enter para omitir)",
			mask: "*",
		});
		if (typed.trim()) apiKey = typed.trim();
	}

	// Guardar URL/key primero para poder listar los modelos del servidor.
	setConfig({
		llmProvider: provider,
		llmBaseUrl: baseUrl.trim() === preset.baseUrl ? undefined : baseUrl.trim(),
		llmApiKey: apiKey,
		llmModel: sameProvider ? current.llmModel : undefined,
	});

	const models = await listModels(resolveLLMSettings());
	let model: string;
	if (models.length > 0 && models.length <= 60) {
		const currentModel = resolveLLMSettings().model;
		model = await select({
			message: "Elige el modelo",
			choices: [...models.map((m) => ({ name: m, value: m })), { name: "Otro (escribirlo)", value: "__other__" }],
			default: models.includes(currentModel) ? currentModel : undefined,
			pageSize: 15,
		});
		if (model === "__other__") model = await input({ message: "Nombre del modelo", default: currentModel });
	} else {
		if (preset.local && !models.length) console.log("  (No pude listar modelos del servidor; ¿está encendido?)");
		model = await input({ message: "Nombre del modelo", default: resolveLLMSettings().model });
	}
	setConfig({ llmModel: model.trim() || undefined });

	if (preset.dialect === "ollama") {
		const ctx = await input({
			message: "Tamaño de contexto en tokens (más = recuerda más, pero usa más memoria)",
			default: String(getConfig().contextWindow),
			validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) >= 1024 ? true : "Número ≥ 1024"),
		});
		setConfig({ contextWindow: Number(ctx.trim()) });
	}

	console.log("  ✓ Modelo configurado\n");
	if (await confirm({ message: "¿Probar la conexión ahora?", default: true })) {
		await runDoctor({ fix: true });
	}
}
