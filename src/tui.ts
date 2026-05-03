import { select, input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getConfig, setConfig, resetConfig } from "./config.js";
import { getLLM } from "./core/llm/getLLM.js";

const MENU_OPTIONS = [
	{ name: "Iniciar web de chat", value: "web" },
	{ name: "Chat en terminal", value: "chat" },
	{ name: "Verificar conexión LLM", value: "check" },
	{ name: "Configurar LLM", value: "provider" },
	{ name: "Salir", value: "exit" },
] as const;

function isPromptCancelled(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const withName = err as { name?: unknown; message?: unknown };
	return withName.name === "ExitPromptError"
		|| (typeof withName.message === "string" && withName.message.toLowerCase().includes("force closed"));
}

export async function runTui(): Promise<void> {
	const name = getState().name;
	console.log(`\n  Shiro — ${name}\n  Usa las flechas para moverte, Enter para elegir.\n`);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		let choice = "";
		try {
			choice = await select({
				message: "¿Qué quieres hacer?",
				choices: MENU_OPTIONS as unknown as { name: string; value: string }[],
				pageSize: 10,
			});
		} catch (err) {
			if (isPromptCancelled(err)) {
				console.log("\n  Detecté Ctrl+C. Cerrando configuración...\n");
				process.exit(0);
			}
			throw err;
		}

		switch (choice) {
			case "web":
				await import("./server.js");
				return;
			case "chat": {
				const { runShiroTUI } = await import("./tui-opencode.js");
				await runShiroTUI();
				break;
			}
			case "check": {
				const cfg = getConfig();
				const provider = cfg.llmProvider ?? "vllm";
				
				if (provider === "ollama") {
					const url = cfg.ollamaBaseUrl ?? "http://localhost:11434";
					console.log(`\n  Verificando Ollama en ${url}...`);
					try {
						const res = await fetch(url + "/api/tags", { method: "GET" });
						if (res.ok) {
							const data = await res.json() as { models?: { name: string }[] };
							const models = data.models?.map(m => m.name).join(", ") ?? "sin modelos";
							console.log(`  ✓ Ollama conectado`);
							console.log(`  Modelos disponibles: ${models}\n`);
						} else {
							console.log(`  ✗ Error: ${res.status} ${res.statusText}\n`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.log(`  ✗ No se pudo conectar: ${msg}\n`);
					}
				} else if (provider === "openrouter") {
					const apiKey = cfg.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "";
					const model = cfg.openrouterModel ?? "openai/gpt-4o-mini";
					if (!apiKey) {
						console.log("\n  ✗ No hay API Key de OpenRouter configurada\n");
					} else {
						console.log(`\n  Verificando OpenRouter (modelo: ${model})...`);
						try {
							const res = await fetch("https://openrouter.ai/api/v1/models", {
								headers: { "Authorization": `Bearer ${apiKey}` },
							});
							if (res.ok) {
								console.log(`  ✓ OpenRouter conectado\n`);
							} else {
								console.log(`  ✗ Error: ${res.status} ${res.statusText}\n`);
							}
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							console.log(`  ✗ No se pudo conectar: ${msg}\n`);
						}
					}
				} else if (provider === "opencode") {
					const apiKey = cfg.opencodeApiKey ?? process.env.OPENCODE_API_KEY ?? "";
					const model = cfg.opencodeModel ?? "kimi-k2.6";
					if (!apiKey) {
						console.log("\n  ✗ No hay API Key de OpenCode configurada\n");
					} else {
						console.log(`\n  Verificando OpenCode (modelo: ${model})...`);
						try {
							const reply = await getLLM().chat([{ role: "user", content: "Responde solo la palabra: ok" }]);
							const preview = reply.replace(/\s+/g, " ").slice(0, 120);
							console.log(`  ✓ OpenCode respondió: ${preview}\n`);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							console.log(`  ✗ Error: ${msg}\n`);
						}
					}
				} else {
					const llm = getLLM();
					const config = llm.getConfig();
					console.log(`\n  Verificando vLLM en ${config.baseUrl}...`);
					try {
						const res = await fetch(config.baseUrl + "/models", {
							method: "GET",
							headers: config.model ? { "Authorization": `Bearer ${config.model}` } : {}
						});
						if (res.ok) {
							console.log(`  ✓ vLLM conectado (modelo: ${config.model})\n`);
						} else {
							console.log(`  ✗ Error: ${res.status} ${res.statusText}\n`);
						}
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.log(`  ✗ No se pudo conectar: ${msg}\n`);
					}
				}
				break;
			}
			case "provider": {
				const provider = await select({
					message: "Elige proveedor",
					choices: [
						{ name: "vLLM", value: "vllm" },
						{ name: "Ollama", value: "ollama" },
						{ name: "OpenRouter", value: "openrouter" },
						{ name: "OpenCode", value: "opencode" },
					],
					default: getConfig().llmProvider ?? "vllm",
				});
				
				if (provider === "vllm") {
					const baseUrl = await input({
						message: "URL de vLLM",
						default: getConfig().vllmBaseUrl ?? "http://127.0.0.1:8000/v1",
					});
					const model = await input({
						message: "Modelo",
						default: getConfig().model ?? "default",
					});
					setConfig({ llmProvider: "vllm", vllmBaseUrl: baseUrl.trim(), model: model.trim() });
					console.log("  ✓ vLLM configurado\n");
				}
				else if (provider === "ollama") {
					const baseUrl = await input({
						message: "URL de Ollama",
						default: getConfig().ollamaBaseUrl ?? "http://localhost:11434",
					});
					const model = await input({
						message: "Modelo (ej. llama3.2, qwen2.5)",
						default: getConfig().ollamaModel ?? "llama3.2",
					});
					setConfig({ llmProvider: "ollama", ollamaBaseUrl: baseUrl.trim(), ollamaModel: model.trim() });
					console.log("  ✓ Ollama configurado\n");
				}
				else if (provider === "openrouter") {
					const apiKey = await input({
						message: "API Key (openrouter.ai)",
						default: getConfig().openrouterApiKey ?? "",
					});
					setConfig({ llmProvider: "openrouter", openrouterApiKey: apiKey.trim() });
					console.log("  ✓ OpenRouter configurado (modelo: gpt-4o-mini por defecto)\n");
				}
				else if (provider === "opencode") {
					const baseUrl = await input({
						message: "Base URL de OpenCode API",
						default: getConfig().opencodeBaseUrl ?? "https://api.opencode.ai/v1",
					});
					const apiKey = await input({
						message: "API Key (OpenCode)",
						default: getConfig().opencodeApiKey ?? "",
					});
					const model = await input({
						message: "Modelo (ej. kimi-k2.6)",
						default: getConfig().opencodeModel ?? "kimi-k2.6",
					});
					setConfig({
						llmProvider: "opencode",
						opencodeBaseUrl: baseUrl.trim().replace(/\/+$/, ""),
						opencodeApiKey: apiKey.trim(),
						opencodeModel: model.trim(),
					});
					console.log("  ✓ OpenCode configurado\n");
				}
				break;
			}
			case "exit":
				console.log("  Hasta luego.\n");
				process.exit(0);
		}
	}
}
