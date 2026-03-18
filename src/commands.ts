import { getConfig } from "./config/config.js";
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
- \`/help\` - Mostrar esta ayuda

**Ejemplos:**
- "/status" → Ver información del sistema
- "/reset" → Empezar conversación desde cero`;

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
- OpenRouter: ${config.openrouterApiKey ? "Configurado" : "Sin API Key"}`;
			return { executed: true, content, shouldContinue: false };
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
