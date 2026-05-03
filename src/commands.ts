import { getConfig, setConfig } from "./config/config.js";
import { getLLM } from "./core/llm/getLLM.js";
import { getHealthState } from "./core/health/HealthManager.js";
import { metrics } from "./core/health/metrics.js";

export interface CommandResult {
	executed: boolean;
	content: string;
	shouldContinue?: boolean;
}

export function parseCommand(message: string, sessionId: string): CommandResult | null {
	const trimmed = message.trim();
	
	if (!trimmed.startsWith("/")) {
		return null;
	}

	const parts = trimmed.slice(1).split(/\s+/);
	const command = parts[0]?.toLowerCase() ?? "";
	const args = parts.slice(1);

	switch (command) {
		case "status": {
			const config = getConfig();
			const llm = getLLM();
			const llmConfig = llm.getConfig();
			const health = getHealthState();
			
			const content = `📊 **Estado de Shiro**

**Sesión:** ${sessionId}

**LLM:**
- Proveedor: ${config.llmProvider}
- Modelo: ${llmConfig.model}
- URL: ${llmConfig.baseUrl}

**Herramientas:** ${config.autonomousMode ? "🟢 Autonomous" : "🔴 Solo chat"}
**Explain tools:** ${config.explainMode ?? "off"}

**Health:**
- Status: ${health.status}
- Tool calls: ${metrics.toolCalls}
- Errores: ${metrics.errors}
- Replans: ${metrics.replans}`;

			return { executed: true, content, shouldContinue: false };
		}

		case "reset":
		case "new": {
			return {
				executed: true,
				content: "🔄 Sesión reiniciada. ¿En qué puedo ayudarte?",
				shouldContinue: false
			};
		}

		case "help": {
			const content = `📚 **Comandos disponibles:**

- \`/status\` - Ver estado del sistema
- \`/reset\` - Reiniciar conversación
- \`/new\` - Nueva sesión
- \`/compact\` - Compactar contexto
- \`/provider\` - Ver proveedor actual
- \`/explain off|brief|on\` - Configura si Shiro explica el uso de tools
- \`/help\` - Mostrar esta ayuda

**Ejemplos:**
- "/explain brief" → Shiro mencionará qué tools usó (breve)
- "/explain off" → Shiro no mencionará tools (estilo OpenClaw)`;

			return { executed: true, content, shouldContinue: false };
		}

		case "compact": {
			const content = `📦 Contexto compactado. La memoria de la sesión ha sido optimizada.`;
			return { executed: true, content, shouldContinue: false };
		}

		case "provider": {
			const config = getConfig();
			const content = `🔧 **Proveedor actual:** ${config.llmProvider}
- vLLM: ${config.vllmBaseUrl}
- Ollama: ${config.ollamaBaseUrl}
- OpenRouter: ${config.openrouterApiKey ? "Configurado" : "Sin API Key"}
- OpenCode: ${(config.opencodeApiKey || process.env.OPENCODE_API_KEY) ? "Configurado" : "Sin API Key"}`;
			return { executed: true, content, shouldContinue: false };
		}

		case "explain":
		case "explica": {
			const modeRaw = (args[0] ?? "").toLowerCase().trim();
			const mode = (modeRaw === "off" || modeRaw === "brief" || modeRaw === "on") ? modeRaw : "";
			if (!mode) {
				const current = getConfig().explainMode ?? "off";
				return {
					executed: true,
					content: `Uso: \`/explain off|brief|on\`\nActual: \`${current}\`\n\n- off: no menciona tools\n- brief: nota corta si usó tools\n- on: lista tools usadas`,
					shouldContinue: false,
				};
			}
			setConfig({ explainMode: mode as "off" | "brief" | "on" });
			return {
				executed: true,
				content: `✅ Listo. explainMode = \`${mode}\``,
				shouldContinue: false,
			};
		}

		default: {
			return {
				executed: true,
				content: `❓ Comando desconocido: /${command}

Usa \`/help\` para ver los comandos disponibles.`,
				shouldContinue: false
			};
		}
	}
}
