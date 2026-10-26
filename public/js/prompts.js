// Ajustes → Personalización → "Instrucciones de Shiro": editar las partes del system prompt
// (instrucciones base, SOUL.md, TOOLS.md y MEMORY.md) y volver al texto original.

import { api } from "./api.js";
import { icon } from "./icons.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** Ayudas de app.js: toast, confirmDialog, name(). */
let ui = null;
/** Tarjetas abiertas (se mantienen al recargar la lista). */
const openCards = new Set();
let workspaceMax = 8000;
let items = [];

function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

const fmt = (n) => n.toLocaleString("es");
/** SOUL.md, TOOLS.md y la memoria comparten espacio en el prompt. */
const NOTES = ["soul", "tools", "memory"];

function paintWorkspaceWarning() {
	const total = items.filter((i) => NOTES.includes(i.id)).reduce((n, i) => n + i.draft.length, 0);
	for (const warn of document.querySelectorAll("#prompt-list .prompt-warn")) {
		warn.hidden = total <= workspaceMax;
		warn.textContent = `SOUL.md, TOOLS.md y la memoria suman ${fmt(total)} caracteres y solo entran unos ${fmt(workspaceMax)}: lo que pase de ahí no lo lee. Acorta alguno.`;
	}
}

function card(it) {
	const box = el("div", `ext-card${openCards.has(it.id) ? " open" : ""}`);
	const head = el("div", "ext-row");
	head.tabIndex = 0;
	head.setAttribute("role", "button");
	head.setAttribute("aria-expanded", String(openCards.has(it.id)));
	head.append(el("span", "chev", icon("chevronRight", "sm")));
	const name = el("span", "ext-name path");
	name.textContent = it.title;
	const chip = el("span", it.custom ? "chip accent" : "chip muted");
	chip.textContent = it.custom ? "Personalizado" : "Original";
	head.append(name, el("span", "spacer"), chip);

	const body = el("div", "ext-body");
	const desc = el("p", "ext-hint");
	desc.textContent = it.description;
	const area = el("textarea", "textarea mono prompt-editor");
	area.rows = 14;
	area.spellcheck = false;
	area.value = it.value;
	area.setAttribute("aria-label", it.title);
	const meta = el("div", "prompt-meta");
	const count = el("span", "ext-hint");
	meta.append(count);
	const warn = el("div", "notice warn prompt-warn");
	warn.hidden = true;
	const actions = el("div", "actions-row");
	const save = el("button", "btn primary sm", "Guardar");
	const undo = el("button", "btn sm", "Descartar cambios");
	const reset = el("button", "btn ghost sm", `${icon("refresh", "sm")}<span>Restaurar el original</span>`);
	actions.append(save, undo, reset);
	body.append(desc, area, meta);
	if (NOTES.includes(it.id)) body.append(warn);
	body.append(actions);

	const paint = () => {
		const dirty = area.value !== it.value;
		save.disabled = !dirty;
		undo.hidden = !dirty;
		reset.disabled = !it.custom && !dirty && area.value.trim() === it.defaultValue.trim();
		count.textContent = `${fmt(area.value.length)} caracteres${dirty ? " · sin guardar" : ""}`;
		it.draft = area.value;
		paintWorkspaceWarning();
	};
	const apply = (next) => {
		Object.assign(it, next, { draft: next.value });
		area.value = it.value;
		chip.className = it.custom ? "chip accent" : "chip muted";
		chip.textContent = it.custom ? "Personalizado" : "Original";
		paint();
	};
	area.addEventListener("input", paint);
	save.onclick = async () => {
		save.disabled = true;
		try {
			const d = await api(`/api/prompts/${it.id}`, { method: "PUT", json: { value: area.value } });
			apply(d.item);
			ui.toast(`Guardado: ${ui.name()} lo usa desde el próximo mensaje`);
		} catch (err) {
			ui.toast(err.message, "error");
			paint();
		}
	};
	undo.onclick = () => {
		area.value = it.value;
		paint();
	};
	reset.onclick = async () => {
		const ok = await ui.confirmDialog({
			title: `¿Volver al texto original de «${it.title}»?`,
			text: it.id === "memory" ? `Se borra lo que ${ui.name()} tiene apuntado en su memoria a largo plazo.` : "Se pierde lo que hayas cambiado.",
			ok: "Restaurar",
			danger: it.id === "memory",
		});
		if (!ok) return;
		try {
			const d = await api(`/api/prompts/${it.id}`, { method: "DELETE" });
			apply(d.item);
			ui.toast("Restaurado el texto original");
		} catch (err) {
			ui.toast(err.message, "error");
		}
	};

	const toggle = () => {
		const open = !box.classList.contains("open");
		box.classList.toggle("open", open);
		head.setAttribute("aria-expanded", String(open));
		if (open) openCards.add(it.id);
		else openCards.delete(it.id);
	};
	head.addEventListener("click", toggle);
	head.addEventListener("keydown", (e) => {
		if ((e.key === "Enter" || e.key === " ") && e.target === head) {
			e.preventDefault();
			toggle();
		}
	});
	box.append(head, body);
	paint();
	return box;
}

/** Se llama al abrir la pestaña Personalización. */
export async function loadPrompts() {
	const list = $("#prompt-list");
	if (!list) return;
	try {
		const d = await api("/api/prompts");
		workspaceMax = d.workspaceMaxChars || workspaceMax;
		items = d.items.map((i) => ({ ...i, draft: i.value }));
	} catch (err) {
		list.innerHTML = "";
		const e = el("div", "ext-empty");
		// Un Shiro abierto de antes de esta opción no conoce /api/prompts.
		e.textContent = err.status === 404 ? `Reinicia ${ui.name()} para editar sus instrucciones desde aquí.` : err.message;
		list.append(e);
		return;
	}
	list.innerHTML = "";
	for (const it of items) list.append(card(it));
	paintWorkspaceWarning();
}

export function initPrompts(helpers) {
	ui = helpers;
}
