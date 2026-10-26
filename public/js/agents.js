// Ajustes → Agentes: crear, editar, probar y borrar agentes (Viernes, Lunes…), y abrir una sala con uno.
// Cada agente tiene su nombre, su modelo, su forma de ser, sus herramientas y su voz.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { listVoices } from "./voice.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** Ayudas de app.js: toast, confirmDialog, name(), openRoom(id), onChange(agents). */
let ui = null;
let data = { agents: [], tools: [], defaultAgent: null, wakeWord: "Aku" };
let providers = [];
const openCards = new Set();

function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

function text(tag, className, value) {
	const e = el(tag, className);
	e.textContent = value;
	return e;
}

const PALETTE = ["#e8833a", "#3a8ee8", "#2fb37d", "#c45bd6", "#e05a6a", "#d4a62a", "#4bb8c4"];

/** Color del agente (el suyo, o uno fijo según el nombre). */
export function agentColor(a) {
	if (a?.color) return a.color;
	const name = String(a?.name || a?.id || "");
	let h = 0;
	for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return PALETTE[h % PALETTE.length];
}

/** Círculo con la inicial del agente (para mensajes, chips y tarjetas). */
export function agentAvatar(a, className = "agent-dot") {
	const dot = text("span", className, (a?.name || "?").trim().charAt(0).toUpperCase());
	dot.style.setProperty("--agent-color", agentColor(a));
	dot.setAttribute("aria-hidden", "true");
	return dot;
}

function modelLabel(a) {
	if (!a.model && !a.provider) return "Modelo de Ajustes";
	const p = providers.find((x) => x.value === a.provider);
	return [p?.title, a.model].filter(Boolean).join(" · ");
}

function card(a) {
	const box = el("div", `ext-card${openCards.has(a.id) ? " open" : ""}`);
	const head = el("div", "ext-row");
	head.tabIndex = 0;
	head.setAttribute("role", "button");
	head.setAttribute("aria-expanded", String(openCards.has(a.id)));
	head.append(el("span", "chev", icon("chevronRight", "sm")), agentAvatar(a), text("span", "ext-name", a.name), el("span", "spacer"));
	if (a.mode === "voice") head.append(text("span", "chip muted", "Voz"));
	head.append(text("span", "chip path", modelLabel(a)));

	const body = el("div", "ext-body");
	if (a.description) body.append(text("p", "ext-hint", a.description));
	const names = [a.name, ...(a.aliases || [])].join(", ");
	body.append(text("p", "ext-hint", `Se le llama: ${names}. Para empezar: «${data.wakeWord}, activa ${a.name}».`));
	const result = el("div", "notice");
	result.hidden = true;
	const actions = el("div", "actions-row");
	const openBtn = el("button", "btn primary sm", `${icon("voice", "sm")}<span>Abrir sala</span>`);
	const testBtn = el("button", "btn sm", "Probar modelo");
	const editBtn = el("button", "btn sm", `${icon("pencil", "sm")}<span>Editar</span>`);
	const delBtn = el("button", "btn ghost sm", `${icon("trash", "sm")}<span>Borrar</span>`);
	actions.append(openBtn, testBtn, editBtn, delBtn);
	body.append(actions, result);

	openBtn.onclick = () => ui.openRoom(a.id);
	testBtn.onclick = async () => {
		testBtn.disabled = true;
		result.hidden = false;
		result.className = "notice";
		result.textContent = "Probando…";
		try {
			const d = await api(`/api/agents/${encodeURIComponent(a.id)}/test`, { method: "POST" });
			result.className = `notice ${d.ok ? "ok" : "bad"}`;
			result.textContent = d.ok ? `Responde bien (${d.model?.model || "modelo"}, ${(d.ms / 1000).toFixed(1)} s).` : d.error;
		} catch (err) {
			result.className = "notice bad";
			result.textContent = err.message;
		} finally {
			testBtn.disabled = false;
		}
	};
	editBtn.onclick = () => editAgent(a);
	delBtn.onclick = async () => {
		const ok = await ui.confirmDialog({
			title: `¿Borrar a ${a.name}?`,
			text: "Sale de las salas en las que esté. Sus mensajes de antes siguen en los chats.",
			ok: "Borrar",
			danger: true,
		});
		if (!ok) return;
		try {
			await api(`/api/agents/${encodeURIComponent(a.id)}`, { method: "DELETE" });
			ui.toast(`${a.name} borrado`);
			await loadAgents();
		} catch (err) {
			ui.toast(err.message, "error");
		}
	};

	const toggle = () => {
		const open = !box.classList.contains("open");
		box.classList.toggle("open", open);
		head.setAttribute("aria-expanded", String(open));
		if (open) openCards.add(a.id);
		else openCards.delete(a.id);
	};
	head.addEventListener("click", toggle);
	head.addEventListener("keydown", (e) => {
		if ((e.key === "Enter" || e.key === " ") && e.target === head) {
			e.preventDefault();
			toggle();
		}
	});
	box.append(head, body);
	return box;
}

function field(label, control, hint) {
	const f = el("label", "field");
	f.append(text("span", "", label), control);
	if (hint) f.append(text("small", "", hint));
	return f;
}

function input(value = "", attrs = {}) {
	const i = el("input", "input");
	i.value = value ?? "";
	Object.assign(i, attrs);
	return i;
}

function segmented(options, value) {
	const seg = el("div", "segmented");
	for (const [v, label] of options) {
		const b = text("button", v === value ? "active" : "", label);
		b.type = "button";
		b.dataset.value = v;
		b.onclick = () => {
			seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
			seg.dataset.value = v;
			seg.dispatchEvent(new Event("change"));
		};
		seg.append(b);
	}
	seg.dataset.value = value;
	return seg;
}

/** Formulario de crear o editar un agente (en su propia ventana). */
function editAgent(agent = null) {
	const a = agent || { name: "", aliases: [], description: "", persona: "", personaMode: "add", tools: "inherit", mcp: true, mode: "text", voice: {}, greeting: "" };
	const d = el("dialog", "agent-dialog");
	const form = el("form");
	form.method = "dialog";
	form.append(text("h2", "", agent ? `Editar a ${agent.name}` : "Nuevo agente"));

	const name = input(a.name, { maxLength: 40, required: true, placeholder: "Viernes" });
	const aliases = input((a.aliases || []).join(", "), { maxLength: 200, placeholder: "Vie, Señor Viernes" });
	const description = input(a.description, { maxLength: 300, placeholder: "Tareas del día, recordatorios y agenda" });
	const grid1 = el("div", "grid-2");
	grid1.append(field("Nombre", name), field("Otros nombres (opcional)", aliases, "Separados por comas. Sirven para llamarlo."));
	form.append(grid1, field("Para qué sirve", description, "Los demás agentes de la sala lo ven."));

	// Modelo: el de Ajustes, o un proveedor y modelo propios.
	const provider = el("select", "select");
	provider.append(new Option("Igual que Ajustes → Modelo", ""));
	for (const p of providers) provider.append(new Option(p.title || p.label, p.value));
	provider.value = a.provider || "";
	const model = input(a.model || "", { maxLength: 200, placeholder: "qwen3:8b" });
	const list = el("datalist");
	list.id = `agent-models-${Math.random().toString(36).slice(2)}`;
	model.setAttribute("list", list.id);
	const baseUrl = input(a.baseUrl || "", { placeholder: "Solo si no está en su dirección de siempre", className: "input mono" });
	const grid2 = el("div", "grid-2");
	grid2.append(field("Proveedor", provider), field("Modelo", model, "Vacío: el de Ajustes (o el del proveedor)."));
	const urlField = field("Dirección del servidor (opcional)", baseUrl);
	form.append(text("h3", "", "Modelo"), grid2, list, urlField);
	const paintProvider = async () => {
		urlField.hidden = !provider.value || provider.value === "gguf";
		list.innerHTML = "";
		const p = provider.value || data.defaultAgent?.provider;
		if (!p) return;
		try {
			const r = await api("/api/models", { method: "POST", json: { provider: p } });
			for (const m of r.models || []) list.append(new Option(m.label || m.id, m.id));
		} catch {}
	};
	provider.onchange = paintProvider;
	paintProvider();
	form.append(text("p", "ext-hint", "Solo se carga un modelo a la vez: al pasar a un agente con otro modelo, el anterior se descarga solo (Ollama, LM Studio y archivos GGUF). Cambiar de modelo tarda unos segundos."));

	// Forma de ser.
	const persona = el("textarea", "textarea");
	persona.rows = 5;
	persona.maxLength = 8000;
	persona.value = a.persona || "";
	persona.placeholder = "Eres ordenado y práctico. Ayudas con las tareas del día…";
	const personaMode = segmented(
		[
			["add", "Además de las instrucciones de siempre"],
			["replace", "En vez de ellas"],
		],
		a.personaMode || "add",
	);
	form.append(text("h3", "", "Forma de ser"), field("Instrucciones", persona, "Puedes usar {{nombre}}, {{usuario}} y {{fecha}}."), personaMode);

	// Herramientas.
	const toolsMode = segmented(
		[
			["inherit", "Las de siempre"],
			["none", "Solo conversar"],
			["list", "Elegir"],
		],
		Array.isArray(a.tools) ? "list" : a.tools || "inherit",
	);
	const toolsBox = el("div", "agent-tools");
	const chosen = new Set(Array.isArray(a.tools) ? a.tools : []);
	for (const t of data.tools) {
		const lab = el("label", "agent-tool");
		const cb = el("input");
		cb.type = "checkbox";
		cb.value = t;
		cb.checked = chosen.has(t);
		lab.append(cb, text("span", "mono", t));
		toolsBox.append(lab);
	}
	const paintTools = () => (toolsBox.hidden = toolsMode.dataset.value !== "list");
	toolsMode.addEventListener("change", paintTools);
	paintTools();
	const mcpRow = el("label", "agent-tool");
	const mcp = el("input");
	mcp.type = "checkbox";
	mcp.checked = a.mcp !== false;
	mcpRow.append(mcp, text("span", "", "También los conectores MCP"));
	form.append(text("h3", "", "Herramientas"), toolsMode, toolsBox, mcpRow);

	// Voz y presentación.
	const mode = segmented(
		[
			["text", "Chat de texto"],
			["voice", "Modo voz"],
		],
		a.mode || "text",
	);
	const browserVoice = el("select", "select");
	browserVoice.append(new Option("La de Ajustes → Voz", ""));
	for (const v of listVoices()) browserVoice.append(new Option(`${v.name} — ${v.lang}`, v.voiceURI));
	browserVoice.value = a.voice?.browserVoiceURI || "";
	const serverVoice = input(a.voice?.serverVoice || "", { maxLength: 40, placeholder: "nova", className: "input mono" });
	const greeting = input(a.greeting || "", { maxLength: 200, placeholder: "Hola, soy {{nombre}}. ¿En qué te ayudo?" });
	const color = input(agentColor(a), { type: "color" });
	color.className = "agent-color";
	const grid3 = el("div", "grid-2");
	grid3.append(field("Voz del navegador", browserVoice), field("Voz del servidor de voz (opcional)", serverVoice, "Si usas un servidor TTS (Ajustes → Voz)."));
	const grid4 = el("div", "grid-2");
	grid4.append(field("Saludo al activarlo", greeting), field("Color", color));
	form.append(text("h3", "", "Al activarlo se abre en"), mode, grid3, grid4);

	const err = el("div", "notice bad");
	err.hidden = true;
	const actions = el("div", "actions-row", `<button type="button" class="btn" data-v="0">Cancelar</button><button class="btn primary" type="submit"></button>`);
	actions.style.cssText = "justify-content:flex-end;margin-top:16px";
	$('[type="submit"]', actions).textContent = agent ? "Guardar" : "Crear agente";
	form.append(err, actions);
	d.append(form);
	document.body.append(d);
	const close = () => {
		d.close();
		d.remove();
	};
	$('[data-v="0"]', actions).onclick = close;
	d.addEventListener("cancel", close);
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const tools =
			toolsMode.dataset.value === "list" ? [...toolsBox.querySelectorAll("input:checked")].map((c) => c.value) : toolsMode.dataset.value;
		const body = {
			name: name.value.trim(),
			aliases: aliases.value.split(",").map((s) => s.trim()).filter(Boolean),
			description: description.value.trim(),
			...(provider.value ? { provider: provider.value } : {}),
			...(model.value.trim() ? { model: model.value.trim() } : {}),
			...(provider.value && baseUrl.value.trim() ? { baseUrl: baseUrl.value.trim() } : {}),
			persona: persona.value,
			personaMode: personaMode.dataset.value,
			tools,
			mcp: mcp.checked,
			mode: mode.dataset.value,
			voice: {
				...(browserVoice.value ? { browserVoiceURI: browserVoice.value } : {}),
				...(serverVoice.value.trim() ? { serverVoice: serverVoice.value.trim() } : {}),
			},
			...(greeting.value.trim() ? { greeting: greeting.value.trim() } : {}),
			color: color.value,
		};
		try {
			const r = agent
				? await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "PUT", json: body })
				: await api("/api/agents", { method: "POST", json: body });
			close();
			for (const w of r.warnings || []) ui.toast(w, "info", 6000);
			ui.toast(agent ? `${r.agent.name} guardado` : `${r.agent.name} creado. Dile «${data.wakeWord}, activa ${r.agent.name}».`);
			openCards.add(r.agent.id);
			await loadAgents();
		} catch (e2) {
			err.hidden = false;
			err.textContent = e2.message;
		}
	});
	d.showModal();
	name.focus();
}

/** Se llama al abrir la pestaña Agentes (y al cambiar algo). Devuelve la lista. */
export async function loadAgents() {
	const listBox = $("#agent-list");
	try {
		const [d, llm] = await Promise.all([api("/api/agents"), providers.length ? null : api("/api/llm-config").catch(() => null)]);
		data = d;
		if (llm?.providers) providers = llm.providers;
	} catch (err) {
		if (listBox) {
			listBox.innerHTML = "";
			// Un Shiro abierto de antes de esta opción no conoce /api/agents.
			listBox.append(text("div", "ext-empty", err.status === 404 ? `Reinicia ${ui.name()} para crear agentes desde aquí.` : err.message));
		}
		return [];
	}
	ui?.onChange(data.agents);
	if (!listBox) return data.agents;
	listBox.innerHTML = "";
	if (data.error) listBox.append(text("div", "ext-empty warn", data.error));
	if (!data.agents.length) {
		listBox.append(
			text(
				"div",
				"ext-empty",
				`Todavía no hay agentes. Crea uno (por ejemplo Viernes, para las tareas del día) y llámalo con «${data.wakeWord}, activa Viernes».`,
			),
		);
	}
	for (const a of data.agents) listBox.append(card(a));
	return data.agents;
}

export function initAgents(helpers) {
	ui = helpers;
	const add = $("#agent-add");
	if (add) add.onclick = () => editAgent(null);
}
