import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, setConfig } from "../../config/config.js";
import { runAgent } from "../agent/Agent.js";
import { LLMError, type LLMClient } from "./LLMClient.js";
import { engineRecentlyFailed, FAILED_ENGINE_MS, fallbackWarnings, markEngineFailed, resetFailedEngines, type FallbackNotice } from "./fallback.js";

type Fake = LLMClient & { calls: number };

/** Un modelo falso: responde con su nombre, o falla con `error` (después de escribir `before`, si lo hay). */
function fake(model: string, baseUrl: string, error?: Error, before?: string): Fake {
	const f: Fake = {
		calls: 0,
		chat: async (_m, opts) => {
			f.calls++;
			if (before) opts?.onDelta?.(before);
			if (error) throw error;
			opts?.onDelta?.(`Responde ${model}`);
			return `Responde ${model}`;
		},
		chatWithTools: async (m, _d, _e, opts) => f.chat(m, opts),
		getConfig: () => ({ provider: "custom", model, baseUrl, local: false }),
	};
	return f;
}

const down = () => new LLMError("No se pudo conectar", "connection");

/** Los respaldos de la config resuelven a estos modelos falsos (por nombre de modelo). */
function useFallbacks(...models: Fake[]) {
	setConfig({ fallbackModels: models.map((m) => ({ provider: "custom", model: m.getConfig().model })) });
	resetFailedEngines((ref) => models.find((m) => m.getConfig().model === ref.model)!);
}

const ask = (llm: LLMClient, notices: FallbackNotice[], stream = false) =>
	runAgent("hola", { llm, agentName: "Aku", mcp: false, textOnly: true, onFallback: (n) => notices.push(n), ...(stream ? { onStreamDelta: () => {} } : {}) });

test("la config guarda hasta 2 respaldos y descarta los que no valen", () => {
	const c = parseConfig({
		fallbackModels: [{ provider: "ollama", model: "qwen3:8b" }, { provider: "no-existe" }, { provider: "opencode" }, { provider: "lmstudio" }],
	});
	assert.deepEqual(c.fallbackModels, [{ provider: "ollama", model: "qwen3:8b" }, { provider: "opencode" }]);
	assert.deepEqual(parseConfig({}).fallbackModels, []);
	assert.deepEqual(parseConfig({ fallbackModels: "nada" }).fallbackModels, []);
});

test("si el modelo no responde, contesta el respaldo, avisa y el motor caído se salta durante un minuto", async () => {
	const main = fake("principal", "http://pc:1234/v1", down());
	const backup = fake("respaldo", "http://nube/v1");
	useFallbacks(backup);
	const notices: FallbackNotice[] = [];
	assert.equal(await ask(main, notices), "Responde respaldo");
	assert.equal(main.calls, 3, "primero se reintenta con el mismo modelo");
	assert.deepEqual(notices, [{ from: "principal", to: "respaldo", reason: "no respondió" }]);
	assert.ok(engineRecentlyFailed(main));

	// Enseguida otra vez: ya no se espera al que falló.
	notices.length = 0;
	assert.equal(await ask(main, notices), "Responde respaldo");
	assert.equal(main.calls, 3);
	assert.equal(notices[0]?.reason, "no respondió hace un momento");

	// Pasado el minuto se le vuelve a dar la oportunidad.
	assert.equal(engineRecentlyFailed(main, Date.now() + FAILED_ENGINE_MS + 1), false);
	setConfig({ fallbackModels: [] });
	resetFailedEngines();
});

test("se prueban los respaldos en orden y se salta el que también falla", async () => {
	const main = fake("principal", "http://pc:1234/v1", new LLMError("Error 503", "server"));
	const first = fake("primero", "http://otro/v1", down());
	const second = fake("segundo", "http://nube/v1");
	useFallbacks(first, second);
	markEngineFailed(first); // falló hace poco: ni se intenta
	const notices: FallbackNotice[] = [];
	assert.equal(await ask(main, notices), "Responde segundo");
	assert.equal(first.calls, 0);
	assert.deepEqual(notices, [{ from: "principal", to: "segundo", reason: "dio un error en su servidor" }]);
	setConfig({ fallbackModels: [] });
	resetFailedEngines();
});

test("no cambia de modelo con una clave mala, si ya escribió algo o si no hay respaldo", async () => {
	const backup = fake("respaldo", "http://nube/v1");
	useFallbacks(backup);
	const notices: FallbackNotice[] = [];

	// Clave mala: otro modelo no lo arregla; se explica el error.
	const badKey = fake("principal", "http://pc:1/v1", new LLMError("401", "auth"));
	assert.notEqual(await ask(badKey, notices), "Responde respaldo");
	// Ya mostró texto: empezar de cero con otro lo repetiría.
	const halfway = fake("principal", "http://pc:2/v1", down(), "Hola, ");
	assert.notEqual(await ask(halfway, notices, true), "Responde respaldo");
	assert.equal(backup.calls, 0);
	assert.deepEqual(notices, []);

	// Sin respaldo puesto: el error de siempre.
	setConfig({ fallbackModels: [] });
	resetFailedEngines();
	const alone = fake("principal", "http://pc:3/v1", down());
	assert.notEqual(await ask(alone, notices), "Responde respaldo");
	assert.deepEqual(notices, []);
});

test("un respaldo sin clave en este equipo se salta y se avisa en Ajustes", async () => {
	const saved = process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_API_KEY;
	const main = fake("principal", "http://pc:4/v1", down());
	const backup = fake("respaldo", "http://nube/v1");
	setConfig({ llmProvider: "gguf", fallbackModels: [{ provider: "ollama-cloud", model: "deepseek-v4.1-flash" }, { provider: "custom", model: "respaldo" }] });
	resetFailedEngines((ref) => (ref.model === "respaldo" ? backup : fake("nube-sin-clave", "https://ollama.com", new LLMError("Falta la API key", "auth"))));
	const notices: FallbackNotice[] = [];
	assert.equal(await ask(main, notices), "Responde respaldo");
	assert.deepEqual(notices, [{ from: "principal", to: "respaldo", reason: "no respondió" }]);
	const warnings = fallbackWarnings(parseConfig({ llmProvider: "gguf", fallbackModels: [{ provider: "ollama-cloud" }, { provider: "ollama" }] }), {});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /primer respaldo \(Ollama Cloud\).*OLLAMA_API_KEY/);
	setConfig({ fallbackModels: [] });
	resetFailedEngines();
	if (saved !== undefined) process.env.OLLAMA_API_KEY = saved;
});
