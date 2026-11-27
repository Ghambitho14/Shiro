// «Elegir modelo solo» (Ajustes → Modelo): el modelo rápido y el potente que reparte `src/core/llm/router.ts`.
// También «Si no responde, usar…»: los modelos de respaldo de `src/core/llm/fallback.ts`.
import { api } from "./api.js";
import { $, el } from "./ui.js";
import { state } from "./state.js";
import { putSettings } from "./settings.js";

const SIDES = [
	["fast", "Modelo rápido", "Para charlar, saludos, lo corto y el modo voz. Normalmente el de tu PC."],
	["strong", "Modelo potente", "Para programar, analizar, imágenes, Code, Hacking y Planear. Normalmente en la nube."],
];

function current() {
	return state.settings?.autoModel || { enabled: false };
}

/** Proveedor y modelo. `none`: la primera opción es «Ninguno» (respaldo) en vez de «Igual que Ajustes → Modelo». */
function sideField(key, title, hint, value, none = false) {
	const providers = state.llm?.providers || [];
	const wrap = el("div", "auto-model-side");
	const head = el("div", "label");
	const strong = el("strong");
	strong.textContent = title;
	const span = el("span");
	span.textContent = hint;
	head.append(strong, span);

	const provider = el("select", "select");
	provider.append(new Option(none ? "Ninguno" : "Igual que Ajustes → Modelo", ""));
	for (const p of providers) provider.append(new Option(p.title || p.label, p.value));
	provider.value = value?.provider || "";
	const model = el("input", "input mono");
	model.maxLength = 200;
	model.value = value?.model || "";
	const list = el("datalist");
	list.id = `auto-model-${key}`;
	model.setAttribute("list", list.id);
	const fillModels = async () => {
		list.innerHTML = "";
		model.disabled = none && !provider.value;
		const p = provider.value || (none ? "" : state.llm?.provider);
		const preset = providers.find((x) => x.value === p);
		model.placeholder = provider.value ? preset?.model || "el que tenga por defecto" : none ? "" : state.llm?.model || "";
		if (!p) return;
		try {
			const r = await api("/api/models", { method: "POST", json: { provider: p } });
			for (const m of r.models || []) list.append(new Option(m.label || m.id, m.id));
		} catch {}
	};
	provider.onchange = fillModels;
	fillModels();

	const grid = el("div", "grid-2");
	const f1 = el("label", "field");
	const s1 = el("span");
	s1.textContent = "Proveedor";
	f1.append(s1, provider);
	const f2 = el("label", "field");
	const s2 = el("span");
	s2.textContent = "Modelo";
	f2.append(s2, model, list);
	grid.append(f1, f2);
	wrap.append(head, grid);
	return { wrap, read: () => (provider.value ? { provider: provider.value, ...(model.value.trim() ? { model: model.value.trim() } : {}) } : undefined) };
}

function paintWarnings(box) {
	const warnings = state.settings?.autoModelWarnings || [];
	const a = current();
	const lines = [...warnings];
	if (a.enabled && !a.fast && !a.strong) lines.unshift("Elige al menos uno de los dos: si ambos son «Igual que Ajustes», siempre responde el mismo modelo.");
	box.hidden = !lines.length;
	box.innerHTML = "";
	for (const line of lines) {
		const p = el("p");
		p.textContent = line;
		box.append(p);
	}
}

/** Pinta el interruptor y, si está encendido, los dos modelos (al abrir Ajustes). */
export function paintAutoModel() {
	const a = current();
	$("#set-auto-model").checked = Boolean(a.enabled);
	const box = $("#auto-model-fields");
	box.hidden = !a.enabled;
	box.innerHTML = "";
	if (!a.enabled) return;
	const sides = SIDES.map(([key, title, hint]) => [key, sideField(key, title, hint, a[key])]);
	const warn = el("div", "notice warn auto-model-warn");
	const save = el("button", "btn primary");
	save.type = "button";
	save.textContent = "Guardar modelos";
	save.onclick = async () => {
		const patch = { ...current(), enabled: true };
		for (const [key, side] of sides) patch[key] = side.read() ?? null;
		if (await putSettings({ autoModel: patch }, "Modelos guardados")) paintWarnings(warn);
	};
	const actions = el("div", "auto-model-actions");
	actions.append(save);
	box.append(...sides.map(([, s]) => s.wrap), warn, actions);
	paintWarnings(warn);
}

/** «Si no responde, usar…»: dos respaldos en orden (al abrir Ajustes). */
export function paintFallbackModels() {
	const box = $("#fallback-fields");
	if (!box) return;
	const saved = state.settings?.fallbackModels || [];
	box.innerHTML = "";
	const rows = [0, 1].map((i) =>
		sideField(`fallback-${i}`, i ? "Si ese tampoco responde" : "Primer respaldo", i ? "Se prueba después del primero." : "Mejor uno de otro lugar: si el tuyo es del PC, uno en la nube (o al revés).", saved[i], true),
	);
	const save = el("button", "btn primary");
	save.type = "button";
	save.textContent = "Guardar respaldo";
	save.onclick = async () => {
		const list = rows.map((r) => r.read()).filter(Boolean);
		await putSettings({ fallbackModels: list }, list.length ? "Respaldo guardado" : "Sin modelos de respaldo");
	};
	const actions = el("div", "auto-model-actions");
	actions.append(save);
	box.append(...rows.map((r) => r.wrap), actions);
}

export function initAutoModel() {
	$("#set-auto-model").onchange = async (e) => {
		const on = e.target.checked;
		const ok = await putSettings({ autoModel: { ...current(), enabled: on } }, on ? "Aku elegirá el modelo en cada mensaje" : "Elegir modelo solo apagado");
		if (!ok) e.target.checked = !on;
		paintAutoModel();
	};
}
