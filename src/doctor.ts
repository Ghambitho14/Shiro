/**
 * `npm run doctor`: comprueba paso a paso que el modelo configurado funciona
 * y recomienda ajustes (por ejemplo, modo texto si el modelo no soporta tools).
 */
import { getConfig, setConfig } from "./config/config.js";
import { resolveLLMSettings, PROVIDER_PRESETS, maskKey, type LLMSettings } from "./core/llm/providers.js";
import { sendTurn } from "./core/llm/transports.js";
import { LLMError, type ToolDef } from "./core/llm/LLMClient.js";
import { parseTextToolCalls, buildTextToolInstructions } from "./core/llm/textTools.js";

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`    ${m}`);

/** Lista los modelos disponibles en el servidor (vacío si no se puede). */
export async function listModels(s: LLMSettings): Promise<string[]> {
	try {
		const url = s.dialect === "ollama" ? `${s.baseUrl}/api/tags` : `${s.baseUrl}/models`;
		const headers: Record<string, string> = {};
		if (s.headers.Authorization) headers.Authorization = s.headers.Authorization;
		const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
		if (!res.ok) return [];
		const data = (await res.json()) as { models?: { name: string }[]; data?: { id: string }[] };
		return (data.models?.map((m) => m.name) ?? data.data?.map((m) => m.id) ?? []).sort();
	} catch {
		return [];
	}
}

const PROBE_TOOL: ToolDef = {
	type: "function",
	function: {
		name: "get_time",
		description: "Devuelve la hora actual",
		parameters: { type: "object", properties: { timezone: { type: "string", description: "Zona horaria, ej. Europe/Madrid" } } },
	},
};

export async function runDoctor(opts: { fix?: boolean } = {}): Promise<boolean> {
	const s = resolveLLMSettings();
	const preset = PROVIDER_PRESETS[s.provider];
	console.log(`\n  Shiro doctor — ${preset.label}`);
	info(`URL: ${s.baseUrl}`);
	info(`Modelo: ${s.model}`);
	if (s.apiKey) info(`API key: ${maskKey(s.apiKey)}`);
	if (s.dialect === "ollama") info(`Contexto (num_ctx): ${s.contextWindow} tokens`);
	console.log("");

	// 1. API key
	if (preset.needsApiKey && !s.apiKey) {
		bad(`Falta la API key. Configúrala con "npm run config" o la variable ${preset.apiKeyEnv ?? "SHIRO_LLM_API_KEY"}.`);
		return false;
	}

	// 2. Servidor y modelo
	const models = await listModels(s);
	if (models.length) {
		ok(`Servidor accesible (${models.length} modelos)`);
		if (s.local && !models.includes(s.model) && !models.some((m) => m.startsWith(`${s.model}:`))) {
			bad(`El modelo "${s.model}" no está en el servidor.`);
			info(`Disponibles: ${models.slice(0, 15).join(", ")}`);
			if (s.provider === "ollama") info(`Descárgalo con: ollama pull ${s.model}`);
			return false;
		}
	} else if (s.local) {
		info("No se pudo listar modelos (se intenta el chat igualmente)");
	}

	// 3. Chat simple
	try {
		const t0 = Date.now();
		const r = await sendTurn(s, { messages: [{ role: "user", content: "Responde solo: ok" }] });
		ok(`El modelo responde (${((Date.now() - t0) / 1000).toFixed(1)}s): "${r.content.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
	} catch (err) {
		bad(err instanceof Error ? err.message : String(err));
		return false;
	}

	// 4. Herramientas nativas
	const question = [{ role: "user" as const, content: "¿Qué hora es? Usa la herramienta get_time." }];
	let recommended: "auto" | "text" = "auto";
	try {
		const r = await sendTurn(s, { messages: question, tools: [PROBE_TOOL] });
		if (r.toolCalls.some((c) => c.function.name === "get_time")) {
			ok("Soporta herramientas nativas");
		} else if (parseTextToolCalls(r.content, new Set(["get_time"])).length) {
			ok("Usa herramientas escribiéndolas como texto (compatible)");
		} else {
			bad("El modelo no llamó a la herramienta. Con este modelo Shiro usará herramientas con menos fiabilidad.");
			info("Sugerencia: prueba un modelo con buen soporte de tools (qwen3, llama3.1+, mistral-nemo, gpt-oss).");
		}
	} catch (err) {
		if (err instanceof LLMError && err.kind === "tools_unsupported") {
			info("No soporta herramientas nativas; probando modo texto...");
			try {
				const r = await sendTurn(s, {
					messages: [{ role: "system", content: buildTextToolInstructions([PROBE_TOOL]) }, ...question],
				});
				if (parseTextToolCalls(r.content, new Set(["get_time"])).length) {
					ok("Funciona con herramientas en modo texto");
					recommended = "text";
				} else {
					bad("Tampoco usa herramientas en modo texto. Recomendado: otro modelo, o desactivar el modo autónomo.");
				}
			} catch (err2) {
				bad(err2 instanceof Error ? err2.message : String(err2));
			}
		} else {
			bad(err instanceof Error ? err.message : String(err));
		}
	}

	if (recommended === "text" && getConfig().toolMode !== "text") {
		info('Recomendado: toolMode = "text" (ahorra una petición fallida en cada mensaje).');
		if (opts.fix) {
			setConfig({ toolMode: "text" });
			ok("Guardado toolMode = text");
		}
	}

	if (s.local && s.dialect !== "ollama") {
		info("Recuerda: el tamaño de contexto se configura en el propio servidor (LM Studio / llama.cpp). Usa 8192 o más.");
	}
	console.log("");
	return true;
}
