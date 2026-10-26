// Formulario "¿Dónde funciona el modelo?" de Ajustes → Modelo (app.js) y del paso "Mi cerebro" de la
// bienvenida (setup.js): tarjetas de proveedores, la lista de modelos que hay (POST /api/models) y solo
// los campos que hacen falta (API key en la nube, dirección en «avanzado»). Con GGUF, el panel de llamacpp.js.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { mountLlamaCppPanel } from "./llamacpp.js";
import { escapeHtml } from "./markdown.js";

const $ = (sel, root) => root.querySelector(sel);

const GROUPS = [
	["pc", "En tu PC", "Gratis y privado: nada sale de tu equipo."],
	["cloud", "En la nube", "Modelos más potentes. Necesitas una cuenta y su API key."],
];
/** Opción del desplegable para escribir un modelo que no está en la lista. */
const OTHER = "__otro__";

/** Aviso dentro del formulario (ok, warn, bad o cargando); sin kind, lo borra. */
function notice(box, kind, text) {
	if (!kind) {
		box.innerHTML = "";
		return;
	}
	const ico = { ok: "check", warn: "alert", bad: "alert", load: "loader" }[kind];
	box.innerHTML = `<div class="notice ${kind === "load" ? "" : kind}">${icon(ico, "sm")}<span></span></div>`;
	box.querySelector("span").textContent = text;
}

/**
 * Monta el formulario en `container`. `llm` es la respuesta de GET /api/llm-config.
 * settings: true añade el botón Guardar y al pulsar «Usar» en un GGUF se guarda en el acto (Ajustes);
 * en la bienvenida se guarda al pasar de paso.
 * Devuelve { save, reset(llm), model(), target() }.
 */
export function mountModelForm(container, { llm, toast, promptDialog, settings = false, onModelChange, onSaved, onTested } = {}) {
	const name = `provider-${Math.random().toString(36).slice(2, 8)}`;
	const card = (p) =>
		`<label class="choice"><input type="radio" name="${name}" value="${escapeHtml(p.value)}" /><div><strong>${escapeHtml(p.title)}${
			p.value === "gguf" ? `<small class="chip accent tiny">Recomendado</small>` : ""
		}</strong><span>${escapeHtml(p.hint)}</span></div></label>`;
	// La recomendada (GGUF) va la primera.
	const cards = (group) =>
		llm.providers
			.filter((p) => p.group === group)
			.sort((a, b) => (b.value === "gguf") - (a.value === "gguf"))
			.map(card)
			.join("");
	container.innerHTML = `
		${GROUPS.map(
			([group, title, desc]) =>
				`<div class="mf-group"><div class="mf-group-head"><strong>${title}</strong><span>${desc}</span></div><div class="choice-list cols">${cards(group)}</div></div>`,
		).join("")}
		<details class="mf-more"><summary>Más opciones (para expertos)</summary><div class="choice-list cols">${cards("advanced")}</div></details>
		<div class="mf-detail">
			<div data-row="llama"></div>
			<div class="field" data-row="model">
				<span>Modelo</span>
				<div class="mf-model-row">
					<select class="select" data-f="model" aria-label="Modelo"></select>
					<input class="input mono" data-f="customModel" placeholder="Nombre exacto del modelo" aria-label="Nombre del modelo" hidden />
					<button type="button" class="btn" data-a="reload" title="Buscar de nuevo" aria-label="Buscar los modelos de nuevo">${icon("refresh", "sm")}</button>
				</div>
				<div data-f="modelNote"></div>
			</div>
			<label class="field" data-row="key"><span data-f="keyLabel">API key</span><input class="input mono" data-f="apiKey" type="password" autocomplete="off" /><small data-f="keyHint"></small></label>
			<details class="mf-adv" data-row="url">
				<summary>Cambiar la dirección del servidor</summary>
				<label class="field"><span>Dirección del servidor</span><input class="input mono" data-f="baseUrl" /></label>
			</details>
		</div>
		<div class="actions-row">
			${settings ? `<button type="button" class="btn primary" data-a="save">Guardar</button>` : ""}
			<button type="button" class="btn" data-a="test">Probar conexión</button>
		</div>
		<div class="model-result"></div>`;

	const f = (n) => $(`[data-f="${n}"]`, container);
	const row = (n) => $(`[data-row="${n}"]`, container);
	const radios = [...container.querySelectorAll(`input[name="${name}"]`)];
	const select = f("model");
	const custom = f("customModel");
	const result = $(".model-result", container);
	let llamaPanel = null;
	/** Con GGUF el modelo se elige en el panel de llama.cpp, no en el desplegable. */
	let ggufModel = "";
	/** Para no pintar una lista vieja si se cambió de proveedor mientras llegaba. */
	let listToken = 0;
	/** El modelo elegido mientras se busca la lista (el desplegable aún está vacío). */
	let pending = null;

	const provider = () => radios.find((r) => r.checked)?.value || llm.provider;
	const preset = () => llm.providers.find((p) => p.value === provider()) || llm.providers[0];
	const currentModel = () => {
		if (preset().managed) return ggufModel;
		if (pending !== null) return pending;
		return select.value === OTHER || select.hidden ? custom.value.trim() : select.value;
	};
	const modelChanged = () => onModelChange?.();

	/** Pinta los campos del proveedor elegido: si es el guardado, con lo guardado; si no, con lo de fábrica. */
	function paint() {
		const p = preset();
		const same = p.value === llm.provider;
		container.querySelector(".mf-more").open ||= p.group === "advanced";
		// Dirección: en la nube no se toca; en Ollama/LM Studio, escondida salvo que no sea la de siempre.
		const baseUrl = same ? llm.baseUrl : p.baseUrl;
		f("baseUrl").value = baseUrl;
		f("baseUrl").placeholder = p.baseUrl;
		row("url").hidden = p.managed || !p.local;
		row("url").open = p.group === "advanced" || baseUrl.replace(/\/+$/, "") !== p.baseUrl.replace(/\/+$/, "");
		// Clave: obligatoria en la nube, opcional en los servidores de «Más opciones», nada en los locales.
		row("key").hidden = !p.needsApiKey && p.group !== "advanced";
		f("keyLabel").textContent = p.needsApiKey ? "API key" : "Clave (opcional)";
		f("apiKey").value = "";
		f("apiKey").placeholder = same && llm.hasApiKey ? "•••••• (guardada; escribe otra para cambiarla)" : p.needsApiKey ? "Pega aquí tu API key" : "Solo si tu servidor la pide";
		f("keyHint").innerHTML = p.needsApiKey
			? `${p.keyUrl ? `<a href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener">¿Dónde la consigo?</a> · ` : ""}Se guarda solo en este equipo.`
			: "";
		// GGUF: el panel de llama.cpp con sus modelos sustituye al desplegable.
		row("model").hidden = Boolean(p.managed);
		row("llama").hidden = !p.managed;
		notice(result, null);
		if (p.managed) {
			ggufModel = same ? llm.model : "";
			if (llamaPanel?.alive()) llamaPanel.refresh();
			else mountLlama();
			modelChanged();
			return;
		}
		loadModels(same ? llm.model : "");
	}

	function mountLlama() {
		llamaPanel = mountLlamaCppPanel(row("llama"), {
			toast,
			promptDialog,
			currentModel: () => ggufModel,
			// Al elegir GGUF por primera vez, se propone el primer modelo encontrado.
			onLoaded: (st) => {
				if (!ggufModel && st.models.length) {
					ggufModel = st.models[0].id;
					modelChanged();
				}
			},
			onUseModel: async (id) => {
				ggufModel = id;
				modelChanged();
				if (settings) {
					await save();
					toast?.(`Modelo: ${id}`);
				}
			},
		});
	}

	/** Pide los modelos del proveedor del formulario (aún sin guardar) y deja elegido `wanted`. */
	async function loadModels(wanted = currentModel()) {
		const p = preset();
		const token = ++listToken;
		pending = wanted;
		select.hidden = false;
		select.disabled = true;
		select.innerHTML = `<option value="">Buscando modelos…</option>`;
		custom.hidden = true;
		notice(f("modelNote"), null);
		let list;
		try {
			list = await api("/api/models", { method: "POST", json: { provider: p.value, baseUrl: f("baseUrl").value.trim(), apiKey: f("apiKey").value.trim() } });
		} catch (err) {
			list = { models: [], error: err.message };
		}
		if (token !== listToken) return;
		pending = null;
		const models = list.models || [];
		const ids = models.map((m) => m.id);
		// Lo de ejemplo del proveedor ("local-model"…) no cuenta como elegido si no está instalado:
		// se propone uno ya cargado en memoria, el de ejemplo si está, o el primero.
		let pick = wanted;
		if (!pick || (pick === p.model && ids.length && !ids.includes(pick))) {
			pick = models.find((m) => m.loaded)?.id || (ids.includes(p.model) ? p.model : ids[0]) || pick;
		}
		pick = ids.find((id) => id === pick || id === `${pick}:latest`) || pick;

		select.disabled = false;
		select.innerHTML = models
			.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(`${m.name ? `${m.name} (${m.id})` : m.id}${m.loaded ? " · cargado" : ""}`)}</option>`)
			.join("");
		select.append(Object.assign(document.createElement("option"), { value: OTHER, textContent: "Otro (escribir el nombre)…" }));
		const listed = ids.includes(pick);
		select.value = listed ? pick : OTHER;
		// Sin lista no tiene sentido el desplegable: directamente el cuadro para escribir.
		select.hidden = !models.length;
		custom.hidden = listed;
		custom.value = listed ? "" : pick;
		custom.placeholder = p.model ? `Por ejemplo: ${p.model}` : "Nombre exacto del modelo";
		if (list.error) notice(f("modelNote"), "warn", list.error);
		else if (!models.length) notice(f("modelNote"), "warn", "No encontré modelos. Descarga uno y pulsa el botón de buscar de nuevo, o escribe su nombre.");
		modelChanged();
	}

	async function save() {
		const p = preset();
		await api("/api/llm-config", {
			method: "PUT",
			json: {
				provider: p.value,
				model: currentModel(),
				// En la nube la dirección es siempre la del proveedor.
				baseUrl: row("url").hidden ? "" : f("baseUrl").value.trim(),
				apiKey: f("apiKey").value.trim(),
			},
		});
		llm = await api("/api/llm-config");
		f("apiKey").value = "";
		f("apiKey").placeholder = llm.hasApiKey ? "•••••• (guardada; escribe otra para cambiarla)" : f("apiKey").placeholder;
		await onSaved?.(llm);
	}

	async function test() {
		notice(result, "load", "Probando… (la primera vez un modelo local puede tardar en cargar)");
		try {
			await save();
			const r = await api("/api/llm-test", { method: "POST" });
			onTested?.(r.ok);
			if (!r.ok) notice(result, "bad", r.error || "El modelo no respondió.");
			else notice(result, "ok", `Funciona: respondió en ${(r.ms / 1000).toFixed(1)} s.`);
			if (llamaPanel?.alive()) llamaPanel.refresh();
		} catch (err) {
			onTested?.(false);
			notice(result, "bad", err.message);
		}
	}

	for (const r of radios) r.onchange = paint;
	select.onchange = () => {
		const other = select.value === OTHER;
		custom.hidden = !other;
		if (other) custom.focus();
		modelChanged();
	};
	custom.onchange = modelChanged;
	// Otra dirección u otra clave: puede haber otros modelos.
	f("baseUrl").onchange = () => loadModels();
	f("apiKey").onchange = () => loadModels();
	container.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-a]");
		if (!b || row("llama").contains(b)) return;
		if (b.dataset.a === "reload") return loadModels();
		if (b.dataset.a === "test") return test();
		if (b.dataset.a === "save") {
			b.disabled = true;
			try {
				await save();
				notice(result, null);
				toast?.("Modelo guardado");
			} catch (err) {
				notice(result, "bad", err.message);
			} finally {
				b.disabled = false;
			}
		}
	});

	function reset(next) {
		llm = next;
		(radios.find((r) => r.value === llm.provider) || radios[0]).checked = true;
		paint();
	}
	reset(llm);

	return {
		save,
		reset,
		model: () => currentModel(),
		target: () => ({ provider: provider(), model: currentModel() }),
	};
}
