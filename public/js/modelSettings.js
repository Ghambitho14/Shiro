// Ajustes de cada modelo (Ajustes → Modelo → "Ajustes de <modelo>"): cómo responde, contexto,
// rendimiento de llama.cpp y herramientas. "Solo este modelo" guarda lo que cambia respecto a
// los generales; "Todos los modelos" cambia los generales. API: /api/model-settings.
import { api } from "./api.js";
import { escapeHtml } from "./markdown.js";

const $ = (sel, root) => root.querySelector(sel);

const opts = (list, value) => {
	const all = list.some(([v]) => String(v) === String(value)) ? list : [...list, [value, String(value)]];
	return all.map(([v, label]) => `<option value="${escapeHtml(String(v))}"${String(v) === String(value) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
};
const tokens = (n) => `${Number(n).toLocaleString("es")} tokens`;

const THINKING = [
	["auto", "Lo que diga el modelo"],
	["on", "Sí (razona mejor, tarda más)"],
	["off", "No (responde enseguida)"],
];
const MAX_TOKENS = [["", "Sin límite"], ...[512, 1024, 2048, 4096, 8192, 16384].map((n) => [n, tokens(n)])];
const LLAMA_CTX = [[0, "Automático (lo que quepa en la tarjeta)"], ...[8192, 16384, 32768, 65536, 131072].map((n) => [n, tokens(n)])];
const OLLAMA_CTX = [4096, 8192, 16384, 32768, 65536, 131072].map((n) => [n, tokens(n)]);
const GPU_LAYERS = [
	["auto", "Automático (lo que quepa)"],
	["all", "Todas"],
	["custom", "Un número…"],
];
const KV_CACHE = [
	["f16", "Normal"],
	["q8_0", "Comprimida (el doble de contexto, casi igual de buena)"],
	["q4_0", "Muy comprimida (aún más contexto, algo peor)"],
];
const AUTO_ON_OFF = [
	["auto", "Automático"],
	["on", "Sí"],
	["off", "No"],
];
const TOOL_MODES = [
	["auto", "Automático (nativas; si el modelo no puede, como texto)"],
	["native", "Nativas"],
	["text", "Escritas como texto (modelos antiguos)"],
];
const TOOL_PROFILES = [
	["auto", "Automático (pocas en modelos locales)"],
	["lite", "Pocas (las esenciales)"],
	["full", "Todas"],
];
const TIMEOUTS = [
	[60000, "1 minuto"],
	[180000, "3 minutos"],
	[300000, "5 minutos"],
	[600000, "10 minutos"],
	[1800000, "30 minutos"],
];

/** Una fila de ajuste: título, explicación y control. */
const row = (title, desc, control, show = "") =>
	`<div class="set-row"${show ? ` data-show="${show}"` : ""}><div class="label"><strong>${title}</strong><span>${desc}</span></div><div class="tuning-ctl">${control}</div></div>`;

/**
 * ctx: { toast, target: () => ({ provider, model }) }. Devuelve { refresh, alive }.
 */
export function mountModelSettings(container, ctx) {
	container.innerHTML = `
		<div class="tuning">
			<h3 class="tuning-title">Ajustes de <span class="mono" data-part="model"></span></h3>
			<div class="tuning-head">
				<div class="segmented" data-part="scope" role="group" aria-label="A qué modelos se aplica">
					<button type="button" data-value="model">Solo este modelo</button>
					<button type="button" data-value="general">Todos los modelos</button>
				</div>
				<span class="chip" data-part="badge"></span>
			</div>
			<p class="set-desc" data-part="hint"></p>
			<details class="tuning-sec" open>
				<summary>Cómo responde</summary>
				${row(
					"Temperatura",
					"Baja: más preciso y repetible. Alta: más creativo y variado.",
					`<label class="tuning-check"><input type="checkbox" data-f="tempDefault" /> La del modelo</label><input type="range" min="0" max="2" step="0.05" data-f="temperature" aria-label="Temperatura" /><b class="tuning-val" data-part="tempVal"></b>`,
				)}
				${row("Pensar antes de responder", "Modelos como Qwen3 pueden razonar en silencio antes de contestar.", `<select class="select" data-f="thinking"></select>`, "thinking")}
				${row("Largo máximo de la respuesta", "Corta las respuestas que se alarguen de más.", `<select class="select" data-f="maxTokens"></select>`)}
			</details>
			<details class="tuning-sec" data-show="context">
				<summary>Contexto</summary>
				${row("Tamaño de contexto", "Cuánto texto tiene en cuenta a la vez: conversación, instrucciones y archivos leídos. Más contexto usa más memoria.", `<select class="select" data-f="contextSize"></select>`, "contextSelect")}
				<p class="tuning-note" data-part="contextInfo"></p>
			</details>
			<details class="tuning-sec" data-show="performance">
				<summary>Rendimiento (llama.cpp)</summary>
				${row("Capas en la tarjeta gráfica", "Cuantas más, más rápido. Si no caben todas, el resto va al procesador (más lento).", `<select class="select" data-f="gpuLayersMode"></select><input class="input tuning-num" type="number" min="0" max="999" data-f="gpuLayers" aria-label="Número de capas" />`)}
				${row("Memoria del contexto", "Comprimida permite el doble de contexto en la misma tarjeta con casi la misma calidad.", `<select class="select" data-f="kvCache"></select>`)}
				${row("Hilos del procesador", "Solo importa si parte del modelo va al procesador. Vacío = automático.", `<input class="input tuning-num" type="number" min="0" max="256" placeholder="Auto" data-f="threads" aria-label="Hilos" />`)}
				${row("Flash attention", "Acelera y ahorra memoria. Hace falta para la memoria comprimida.", `<select class="select" data-f="flashAttention"></select>`)}
				<p class="tuning-note">Los cambios de contexto y rendimiento reinician llama.cpp con el siguiente mensaje.</p>
			</details>
			<details class="tuning-sec">
				<summary>Herramientas</summary>
				${row("Cómo las usa", "Nativas es lo normal. «Como texto» sirve para modelos que no saben usarlas.", `<select class="select" data-f="toolMode"></select>`)}
				${row("Cuántas ve", "Los modelos pequeños se confunden con muchas: mejor pocas.", `<select class="select" data-f="toolProfile"></select>`)}
				${row("Pasos máximos por respuesta", "Cuántas herramientas puede usar seguidas antes de contestar.", `<input class="input tuning-num" type="number" min="1" max="40" data-f="maxToolIterations" aria-label="Pasos máximos" />`)}
				${row("Tiempo máximo de espera", "Si el modelo tarda más en responder, se corta.", `<select class="select" data-f="timeoutMs"></select>`)}
			</details>
			<div class="actions-row">
				<button type="button" class="btn primary" data-a="save">Guardar</button>
				<button type="button" class="btn" data-a="reset">Volver a los generales</button>
			</div>
		</div>`;

	const f = (name) => $(`[data-f="${name}"]`, container);
	const part = (name) => $(`[data-part="${name}"]`, container);
	let st = null;
	let scope = "model";
	let loadedKey = "";
	const alive = () => container.isConnected && Boolean($(".tuning", container));

	function paintTemp() {
		const def = f("tempDefault").checked;
		f("temperature").disabled = def;
		part("tempVal").textContent = def ? "" : Number(f("temperature").value).toFixed(2);
	}

	function paintGpu() {
		f("gpuLayers").hidden = f("gpuLayersMode").value !== "custom";
	}

	function paint() {
		const v = scope === "general" ? st.general : st.effective;
		part("model").textContent = st.model;
		paintScope();
		part("badge").textContent = st.own ? "Tiene ajustes propios" : "Usa los generales";
		part("badge").classList.toggle("accent", Boolean(st.own));
		part("hint").textContent =
			scope === "general"
				? "Se aplican a todos los modelos que no tengan ajustes propios."
				: `Solo para ${st.model}. Lo que no cambies sigue a los generales.`;

		f("tempDefault").checked = v.temperature === undefined || v.temperature === null;
		f("temperature").value = v.temperature ?? 0.7;
		paintTemp();
		f("thinking").innerHTML = opts(THINKING, v.thinking);
		f("maxTokens").innerHTML = opts(MAX_TOKENS, v.maxTokens ?? "");

		const c = st.fields.context;
		const show = (name, on) => container.querySelectorAll(`[data-show="${name}"]`).forEach((el) => (el.hidden = !on));
		show("thinking", st.fields.thinking);
		show("context", Boolean(c));
		show("contextSelect", c === "llama" || c === "ollama");
		show("performance", st.fields.performance);
		if (c === "llama") f("contextSize").innerHTML = opts(LLAMA_CTX, v.contextSize);
		else if (c === "ollama") f("contextSize").innerHTML = opts(OLLAMA_CTX, v.contextSize);
		const info = [];
		if (c === "llama" && st.contextNow) info.push(`Ahora llama.cpp tiene ${tokens(st.contextNow)} con este modelo.`);
		if (c === "ollama") info.push("Ollama recorta en silencio lo que no cabe: si el modelo «olvida» las instrucciones, sube el contexto.");
		if (c === "note") {
			info.push(st.contextNote || "El tamaño de contexto se elige en el programa que sirve el modelo.");
			if (st.contextNow) info.push(`Ahora mismo: ${tokens(st.contextNow)}.`);
		}
		part("contextInfo").textContent = info.join(" ");

		const gl = v.gpuLayers;
		f("gpuLayersMode").innerHTML = opts(GPU_LAYERS, typeof gl === "number" ? "custom" : gl);
		f("gpuLayers").value = typeof gl === "number" ? gl : "";
		paintGpu();
		f("kvCache").innerHTML = opts(KV_CACHE, v.kvCache);
		f("threads").value = v.threads > 0 ? v.threads : "";
		f("flashAttention").innerHTML = opts(AUTO_ON_OFF, v.flashAttention);
		f("toolMode").innerHTML = opts(TOOL_MODES, v.toolMode);
		f("toolProfile").innerHTML = opts(TOOL_PROFILES, v.toolProfile);
		f("maxToolIterations").value = v.maxToolIterations;
		f("timeoutMs").innerHTML = opts(TIMEOUTS, v.timeoutMs);
		$('[data-a="reset"]', container).hidden = scope === "general" || !st.own;
	}

	function paintScope() {
		part("scope")
			.querySelectorAll("button")
			.forEach((b) => b.classList.toggle("active", b.dataset.value === scope));
	}

	/** Lo que hay en el formulario. null = "el valor por defecto" (la temperatura del modelo, sin límite). */
	function collect() {
		const num = (el, fallback) => (el.value === "" ? fallback : Number(el.value));
		const values = {
			temperature: f("tempDefault").checked ? null : Number(f("temperature").value),
			maxTokens: f("maxTokens").value ? Number(f("maxTokens").value) : null,
			toolMode: f("toolMode").value,
			toolProfile: f("toolProfile").value,
			maxToolIterations: Math.min(40, Math.max(1, num(f("maxToolIterations"), 10))),
			timeoutMs: Number(f("timeoutMs").value),
		};
		if (st.fields.thinking) values.thinking = f("thinking").value;
		if (st.fields.context === "llama" || st.fields.context === "ollama") values.contextSize = Number(f("contextSize").value);
		if (st.fields.performance) {
			const mode = f("gpuLayersMode").value;
			values.gpuLayers = mode === "custom" ? Math.min(999, Math.max(0, num(f("gpuLayers"), 0))) : mode;
			values.kvCache = f("kvCache").value;
			values.threads = Math.min(256, Math.max(0, num(f("threads"), 0)));
			values.flashAttention = f("flashAttention").value;
		}
		return values;
	}

	async function refresh() {
		const t = ctx.target();
		if (!t.model) return;
		try {
			st = await api(`/api/model-settings?provider=${encodeURIComponent(t.provider)}&model=${encodeURIComponent(t.model)}`);
		} catch (err) {
			ctx.toast?.(err.message, "error");
			return;
		}
		if (!alive()) return;
		const key = `${st.provider}|${st.model}`;
		// Al cambiar de modelo se empieza por sus ajustes; al recargar el mismo, se respeta la pestaña elegida.
		if (key !== loadedKey) scope = "model";
		loadedKey = key;
		paint();
	}

	part("scope").onclick = (e) => {
		const b = e.target.closest("button[data-value]");
		if (!b || !st) return;
		scope = b.dataset.value;
		paint();
	};
	f("tempDefault").onchange = paintTemp;
	f("temperature").oninput = paintTemp;
	f("gpuLayersMode").onchange = paintGpu;

	container.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-a]");
		if (!b || !st) return;
		b.disabled = true;
		try {
			if (b.dataset.a === "save") {
				st = await api("/api/model-settings", { method: "PUT", json: { provider: st.provider, model: st.model, scope, values: collect() } });
				ctx.toast?.(scope === "general" ? "Ajustes generales guardados" : st.own ? `Ajustes de ${st.model} guardados` : `${st.model} usa los ajustes generales`);
			} else if (b.dataset.a === "reset") {
				st = await api(`/api/model-settings?provider=${encodeURIComponent(st.provider)}&model=${encodeURIComponent(st.model)}`, { method: "DELETE" });
				ctx.toast?.(`${st.model} vuelve a los ajustes generales`);
			}
			if (alive()) paint();
		} catch (err) {
			ctx.toast?.(err.message, "error");
		} finally {
			b.disabled = false;
		}
	});

	refresh();
	return { refresh, alive };
}
