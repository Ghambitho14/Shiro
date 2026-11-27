import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../../config/config.js";
import { autoModelWarnings, pickTier, routeModel, type RouteInput } from "./router.js";
import { getLLM } from "./getLLM.js";
import { lacksApiKey } from "./providers.js";

const chat: RouteInput = { mode: "chat", planning: false, moreReasoning: false, voice: false, images: false };

test("lo corto y los saludos van al rápido; el trabajo pesado al potente", () => {
	assert.deepEqual(pickTier("hola", chat), { tier: "fast", reason: "charla corta" });
	assert.deepEqual(pickTier("Buenos días, ¿qué tal?", chat), { tier: "fast", reason: "charla corta" });
	assert.equal(pickTier("¿qué hora es en Madrid?", chat).tier, "fast");
	assert.equal(pickTier("recuérdame comprar pan mañana", chat).tier, "fast");

	const heavy = pickTier("depura este código, por favor", chat);
	assert.equal(heavy.tier, "strong");
	assert.match(heavy.reason, /depura/);
	assert.equal(pickTier("Analiza estas dos opciones", chat).tier, "strong");
	assert.equal(pickTier("compara precios de portátiles", chat).tier, "strong");
	assert.equal(pickTier("¿Por qué falla mi función?", chat).tier, "strong");
	assert.equal(pickTier("diseña la arquitectura del backend", chat).tier, "strong");
});

test("código, mensajes largos e imágenes van al potente", () => {
	assert.deepEqual(pickTier("mira:\n```js\nconst a = 1\n```", chat), { tier: "strong", reason: "lleva código" });
	assert.deepEqual(pickTier("palabra ".repeat(100), chat), { tier: "strong", reason: "mensaje largo" });
	assert.deepEqual(pickTier("¿qué ves?", { ...chat, images: true }), { tier: "strong", reason: "lleva imágenes" });
});

test("el modo y los botones mandan sobre el texto", () => {
	assert.equal(pickTier("hola", { ...chat, mode: "code" }).tier, "strong");
	assert.equal(pickTier("hola", { ...chat, mode: "hacking" }).tier, "strong");
	assert.equal(pickTier("hola", { ...chat, planning: true }).tier, "strong");
	assert.equal(pickTier("hola", { ...chat, moreReasoning: true }).tier, "strong");
	// La voz quiere respuesta rápida aunque diga una palabra pesada.
	assert.deepEqual(pickTier("analiza el tiempo de hoy", { ...chat, voice: true }), { tier: "fast", reason: "modo voz" });
	// Una palabra que solo empieza parecido no cuenta: «errores» sí (error), «terror» no.
	assert.equal(pickTier("cuéntame una historia de terror", chat).tier, "fast");
});

test("apagado o sin modelos elegidos no cambia nada", () => {
	assert.equal(routeModel("depura esto", chat, parseConfig({})), null);
	assert.equal(routeModel("depura esto", chat, parseConfig({ autoModel: { enabled: true } })), null);
	assert.equal(routeModel("depura esto", chat, parseConfig({ autoModel: { enabled: false, strong: { provider: "opencode-go" } } })), null);
});

test("encendido, cada mensaje va a su modelo", () => {
	const cfg = parseConfig({
		autoModel: { enabled: true, fast: { provider: "ollama", model: "qwen3:4b" }, strong: { provider: "ollama", model: "qwen3:32b" } },
	});
	const fast = routeModel("hola", chat, cfg);
	assert.equal(fast?.tier, "fast");
	assert.equal(fast?.model, "qwen3:4b");
	assert.equal(fast?.llm.getConfig().model, "qwen3:4b");
	const strong = routeModel("depura este código", chat, cfg);
	assert.equal(strong?.tier, "strong");
	assert.equal(strong?.model, "qwen3:32b");
	assert.equal(strong?.llm.getConfig().provider, "ollama");
});

test("la configuración rara no rompe nada", () => {
	const cfg = parseConfig({ autoModel: { enabled: true, fast: { provider: "no-existe" }, strong: "x" } });
	assert.equal(cfg.autoModel.enabled, true);
	assert.equal(cfg.autoModel.fast, undefined);
	assert.equal(cfg.autoModel.strong, undefined);
	assert.deepEqual(parseConfig({ autoModel: 5 }).autoModel, { enabled: false });
});

test("avisos: dos modelos del PC y una nube sin clave", () => {
	const both = parseConfig({ llmProvider: "ollama", autoModel: { enabled: true, fast: { provider: "ollama", model: "a" }, strong: { provider: "lmstudio", model: "b" } } });
	assert.match(autoModelWarnings(both, {}).join("\n"), /Los dos modelos son de tu PC/);

	const cloud = parseConfig({ llmProvider: "ollama", autoModel: { enabled: true, fast: { provider: "ollama", model: "a" }, strong: { provider: "openrouter", model: "x" } } });
	assert.match(autoModelWarnings(cloud, {}).join("\n"), /OPENROUTER_API_KEY/);
	assert.deepEqual(autoModelWarnings(cloud, { OPENROUTER_API_KEY: "sk-prueba" }), []);

	// La nube elegida es la misma de Ajustes: usa su clave guardada, sin aviso.
	const same = parseConfig({ llmProvider: "openrouter", autoModel: { enabled: true, fast: { provider: "ollama", model: "a" }, strong: { provider: "openrouter", model: "x" } } });
	assert.deepEqual(autoModelWarnings(same, {}), []);
});

test("un modelo de la nube sin clave en este equipo se salta: responde el de Ajustes", () => {
	const saved = process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_API_KEY;
	// Lo que le pasó a Jhon: el principal es local y por voz iba a Ollama Cloud, que no tiene clave aquí.
	const cfg = parseConfig({ llmProvider: "gguf", autoModel: { enabled: true, fast: { provider: "ollama-cloud", model: "deepseek-v4.1-flash" } } });
	const r = routeModel("Hey, ¿cómo estás?", { ...chat, voice: true }, cfg);
	assert.equal(r?.llm, getLLM());
	assert.match(r?.reason ?? "", /Ollama Cloud no tiene clave/);
	assert.match(autoModelWarnings(cfg, {}).join("\n"), /OLLAMA_API_KEY/);
	if (saved !== undefined) process.env.OLLAMA_API_KEY = saved;
});

test("cuándo falta la clave: la de Ajustes solo vale para su proveedor; la variable de entorno vale siempre", () => {
	const cfg = parseConfig({ llmProvider: "opencode-go", llmApiKey: "clave-guardada" });
	assert.equal(lacksApiKey({ provider: "opencode-go" }, cfg, {}), false);
	assert.equal(lacksApiKey({ provider: "ollama-cloud" }, cfg, {}), true);
	assert.equal(lacksApiKey({ provider: "ollama-cloud" }, cfg, { OLLAMA_API_KEY: "k" }), false);
	assert.equal(lacksApiKey({ provider: "ollama" }, cfg, {}), false);
	assert.equal(lacksApiKey({ provider: "opencode-go" }, parseConfig({ llmProvider: "opencode-go" }), {}), true);
});
