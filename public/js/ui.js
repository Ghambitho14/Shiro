// Utilidades de la interfaz: $ y compañía, preferencias guardadas, tema, avisos, diálogos y menús.
import { icon, setIcon } from "./icons.js";

// ───────────────────────────── utilidades ─────────────────────────────

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const norm = (s) =>
	String(s || "")
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase();

export function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

export async function waitFor(pred, every = 200) {
	while (!pred()) await sleep(every);
}

export const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

// ───────────────────────────── preferencias locales ─────────────────────────────

export const LANGS = ["es-ES", "es-MX", "es-US", "es-AR", "es-CL", "es-CO", "es-PE", "es-VE", "en-US", "pt-BR"];

export function readJSON(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "{}") || {};
	} catch {
		return {};
	}
}

export const prefs = Object.assign(
	{
		enterSend: true,
		lang: LANGS.includes(navigator.language) ? navigator.language : "es-ES",
		ttsVoice: "",
		ttsRate: 1,
		autoRead: false,
		sidebarCollapsed: false,
	},
	readJSON("shiro.prefs"),
);

export function savePrefs() {
	try {
		localStorage.setItem("shiro.prefs", JSON.stringify(prefs));
	} catch {}
}

export function getThemePref() {
	try {
		return localStorage.getItem("shiro.theme") || "system";
	} catch {
		return "system";
	}
}

// ───────────────────────────── tema ─────────────────────────────

export const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(pref = getThemePref()) {
	const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	$("#hljs-theme").href = dark ? "/vendor/hljs-dark.css" : "/vendor/hljs-light.css";
	setIcon($("#theme-btn"), dark ? "sun" : "moon");
	$$("#theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.value === pref));
}

export function setTheme(pref) {
	try {
		localStorage.setItem("shiro.theme", pref);
	} catch {}
	applyTheme(pref);
}

darkQuery.addEventListener("change", () => applyTheme());

// ───────────────────────────── avisos ─────────────────────────────

export function toast(message, kind = "info", ms = 3800) {
	const t = el("div", `toast ${kind === "error" ? "error" : ""}`);
	t.innerHTML = `${icon(kind === "error" ? "alert" : kind === "bell" ? "bell" : "check", "sm")}<span></span>`;
	t.querySelector("span").textContent = message;
	// Con una ventana modal abierta (Ajustes) el aviso tiene que ir dentro o queda tapado por ella.
	const box = $("#toasts");
	const host = $$("dialog[open]").pop() || document.body;
	if (box.parentElement !== host) host.append(box);
	box.append(t);
	setTimeout(() => t.remove(), ms);
}

export function notifySystem(title, body) {
	if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
	try {
		const n = new Notification(title, { body, icon: "/icons/icon-192.png" });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {}
}

export function confirmDialog({ title, text, ok = "Aceptar", danger = false }) {
	return new Promise((resolve) => {
		const d = el("dialog");
		d.style.width = "420px";
		d.innerHTML = `<div style="padding:22px 24px 18px"><h2 style="margin:0 0 8px;font:600 18px/1.3 var(--font-display)"></h2><p style="margin:0 0 20px;color:var(--text-2);font-size:14px"></p><div class="actions-row" style="justify-content:flex-end"><button class="btn" data-v="0">Cancelar</button><button class="btn ${danger ? "danger" : "primary"}" data-v="1"></button></div></div>`;
		d.querySelector("h2").textContent = title;
		d.querySelector("p").textContent = text;
		d.querySelector('[data-v="1"]').textContent = ok;
		document.body.append(d);
		const done = (v) => {
			d.close();
			d.remove();
			resolve(v);
		};
		d.addEventListener("click", (e) => {
			const v = e.target.closest("[data-v]")?.dataset.v;
			if (v) done(v === "1");
		});
		d.addEventListener("cancel", (e) => {
			e.preventDefault();
			done(false);
		});
		d.showModal();
		d.querySelector('[data-v="1"]').focus();
	});
}

export function lightbox(src) {
	const lb = el("div", "lightbox");
	const img = el("img");
	img.src = src;
	img.alt = "Imagen ampliada";
	lb.append(img);
	const close = () => {
		lb.remove();
		document.removeEventListener("keydown", onKey, true);
	};
	const onKey = (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	};
	lb.onclick = close;
	document.addEventListener("keydown", onKey, true);
	document.body.append(lb);
}

export async function copyText(text, btn) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = el("textarea");
		ta.value = text;
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
	if (btn) {
		const prev = btn.dataset.icon;
		setIcon(btn, "check");
		setTimeout(() => setIcon(btn, prev), 1500);
	}
}

// ───────────────────────────── menús ─────────────────────────────

export let openMenuEl = null;
export let menuAnchor = null;

export function closeMenu() {
	if (!openMenuEl) return;
	openMenuEl.remove();
	menuAnchor?.classList.remove("menu-open");
	openMenuEl = null;
	menuAnchor = null;
	document.removeEventListener("pointerdown", onOutside, true);
}

export function onOutside(e) {
	if (openMenuEl && !openMenuEl.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
}

export function placeMenu(menu, anchor, align = "left") {
	const r = anchor.getBoundingClientRect();
	const w = menu.offsetWidth;
	const h = menu.offsetHeight;
	let left = align === "right" ? r.right - w : r.left;
	let top = r.bottom + 6;
	if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
	menu.style.left = `${clamp(left, 8, window.innerWidth - w - 8)}px`;
	menu.style.top = `${clamp(top, 8, window.innerHeight - h - 8)}px`;
}

export function showMenu(menu, anchor, align) {
	closeMenu();
	// Dentro de una ventana modal (Ajustes) el menú tiene que ir dentro: lo de fuera no se puede tocar.
	(anchor.closest("dialog") || document.body).append(menu);
	placeMenu(menu, anchor, align);
	openMenuEl = menu;
	menuAnchor = anchor;
	anchor.classList.add("menu-open");
	document.addEventListener("pointerdown", onOutside, true);
}

export function openMenu(anchor, items, align = "left") {
	const menu = el("div", "menu");
	menu.setAttribute("role", "menu");
	for (const it of items) {
		if (it === "sep") {
			menu.append(el("div", "menu-sep"));
			continue;
		}
		const b = el("button", `menu-item${it.danger ? " danger" : ""}`, `${it.icon ? icon(it.icon, "sm") : ""}<span></span>`);
		b.querySelector("span").textContent = it.label;
		b.setAttribute("role", "menuitem");
		b.onclick = () => {
			closeMenu();
			it.onClick();
		};
		menu.append(b);
	}
	showMenu(menu, anchor, align);
	menu.querySelector("button")?.focus();
}
