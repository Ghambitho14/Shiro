// Shiro — interfaz de chat.
import { hydrateIcons, icon, setIcon } from "./icons.js";
import { answerApproval, api, protectedImageUrl, streamChat } from "./api.js";
import { escapeHtml, renderMarkdown, toSpeechText } from "./markdown.js";
import { listVoices, parseYesNo, Recognizer, SentenceSplitter, Speaker, voiceSupport } from "./voice.js";
import { initExtensions, onSettingsTab, promptDialog } from "./extensions.js";
import * as projects from "./projects.js";
import { initPrompts, loadPrompts } from "./prompts.js";
import { CommandPalette } from "./commands.js";
import { HoloOrb } from "./orb.js";
import { initPanels } from "./panels.js";
import { initSetup, mountStorageForm, openSetup } from "./setup.js";
import { mountModelForm } from "./modelForm.js";
import { mountModelSettings } from "./modelSettings.js";
import { agentAvatar, agentColor, initAgents, loadAgents } from "./agents.js";

// ───────────────────────────── utilidades ─────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const norm = (s) =>
	String(s || "")
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase();

function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

async function waitFor(pred, every = 200) {
	while (!pred()) await sleep(every);
}

const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

// ───────────────────────────── preferencias locales ─────────────────────────────

const LANGS = ["es-ES", "es-MX", "es-US", "es-AR", "es-CL", "es-CO", "es-PE", "es-VE", "en-US", "pt-BR"];

function readJSON(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "{}") || {};
	} catch {
		return {};
	}
}

const prefs = Object.assign(
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

function savePrefs() {
	try {
		localStorage.setItem("shiro.prefs", JSON.stringify(prefs));
	} catch {}
}

function getThemePref() {
	try {
		return localStorage.getItem("shiro.theme") || "system";
	} catch {
		return "system";
	}
}

// ───────────────────────────── estado ─────────────────────────────

const state = {
	sessions: [],
	activeId: null,
	messages: [],
	busy: false,
	controller: null,
	attachments: [],
	settings: null,
	llm: null,
	profile: {},
	name: "Shiro",
	search: "",
	/** Id del proyecto cuya página está abierta (sin chat elegido): el próximo chat nace en él. */
	projectHome: null,
	/** "chat" o "projects" (la lista de proyectos). */
	view: "chat",
	placeholder: "",
	/** Agentes de Ajustes → Agentes (para nombres, colores y voces). */
	agents: [],
	/** Sala del chat abierto (participantes y principal), o null si es un chat normal. */
	room: null,
};

/** Referencias DOM de cada mensaje. */
const refs = new WeakMap();
/** El modo voz (se define más abajo). */
let voice_ = null;

const input = $("#input");
const thread = $("#thread");
const messagesBox = $("#messages");

// ───────────────────────────── tema ─────────────────────────────

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(pref = getThemePref()) {
	const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	$("#hljs-theme").href = dark ? "/vendor/hljs-dark.css" : "/vendor/hljs-light.css";
	setIcon($("#theme-btn"), dark ? "sun" : "moon");
	$$("#theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.value === pref));
}

function setTheme(pref) {
	try {
		localStorage.setItem("shiro.theme", pref);
	} catch {}
	applyTheme(pref);
}

darkQuery.addEventListener("change", () => applyTheme());

// ───────────────────────────── avisos ─────────────────────────────

function toast(message, kind = "info", ms = 3800) {
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

function notifySystem(title, body) {
	if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
	try {
		const n = new Notification(title, { body, icon: "/icons/icon-192.png" });
		n.onclick = () => {
			window.focus();
			n.close();
		};
	} catch {}
}

function confirmDialog({ title, text, ok = "Aceptar", danger = false }) {
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

function lightbox(src) {
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

async function copyText(text, btn) {
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

let openMenuEl = null;
let menuAnchor = null;

function closeMenu() {
	if (!openMenuEl) return;
	openMenuEl.remove();
	menuAnchor?.classList.remove("menu-open");
	openMenuEl = null;
	menuAnchor = null;
	document.removeEventListener("pointerdown", onOutside, true);
}

function onOutside(e) {
	if (openMenuEl && !openMenuEl.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
}

function placeMenu(menu, anchor, align = "left") {
	const r = anchor.getBoundingClientRect();
	const w = menu.offsetWidth;
	const h = menu.offsetHeight;
	let left = align === "right" ? r.right - w : r.left;
	let top = r.bottom + 6;
	if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
	menu.style.left = `${clamp(left, 8, window.innerWidth - w - 8)}px`;
	menu.style.top = `${clamp(top, 8, window.innerHeight - h - 8)}px`;
}

function showMenu(menu, anchor, align) {
	closeMenu();
	// Dentro de una ventana modal (Ajustes) el menú tiene que ir dentro: lo de fuera no se puede tocar.
	(anchor.closest("dialog") || document.body).append(menu);
	placeMenu(menu, anchor, align);
	openMenuEl = menu;
	menuAnchor = anchor;
	anchor.classList.add("menu-open");
	document.addEventListener("pointerdown", onOutside, true);
}

function openMenu(anchor, items, align = "left") {
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

// ───────────────────────────── contenido de mensajes ─────────────────────────────

const FILE_RE = /\n*<<<archivo: ([^>\n]+)>>>\n[\s\S]*?\n<<<fin del archivo>>>/g;

/** Separa lo que se muestra (texto, imágenes, nombres de archivos) del contenido enviado al modelo. */
function contentParts(content) {
	let raw = "";
	let images = [];
	if (typeof content === "string") raw = content;
	else if (Array.isArray(content)) {
		raw = content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("\n");
		images = content.filter((p) => p.type === "image_url").map((p) => p.image_url.url);
	}
	const files = [...raw.matchAll(FILE_RE)].map((m) => m[1]);
	const text = raw.replace(FILE_RE, "").trim();
	return { text, images, files, raw };
}

function fileBlocks(raw) {
	return [...String(raw).matchAll(FILE_RE)].map((m) => m[0]).join("");
}

function buildContent(text, attachments) {
	let full = text;
	for (const a of attachments.filter((x) => x.kind === "file")) {
		full += `\n\n<<<archivo: ${a.name}>>>\n${a.text}\n<<<fin del archivo>>>`;
	}
	const images = attachments.filter((a) => a.kind === "image");
	if (!images.length) return full.trim();
	return [{ type: "text", text: full.trim() || "¿Qué hay en esta imagen?" }, ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } }))];
}

function replaceText(content, newText) {
	if (typeof content === "string") return (newText + fileBlocks(content)).trim();
	const { raw, images } = contentParts(content);
	return [{ type: "text", text: (newText + fileBlocks(raw)).trim() || "¿Qué hay en esta imagen?" }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

function fromServer(m) {
	const out = { role: m.role, content: m.content, ts: m.ts };
	if (m.agent) Object.assign(out, { agent: m.agent, agentName: m.agentName });
	if (Array.isArray(m.tools)) out.tools = m.tools.map((t, i) => ({ id: `h${i}`, name: t.name, label: t.label, status: t.ok === false ? "fail" : "ok", image: t.image }));
	return out;
}

function serialize(m) {
	const o = { role: m.role, content: m.content };
	if (m.ts) o.ts = m.ts;
	if (m.agent) Object.assign(o, { agent: m.agent, agentName: m.agentName });
	if (m.tools?.length) {
		o.tools = m.tools.map((t) => ({ name: t.name, label: t.label, ok: t.status !== "fail", ...(t.image ? { image: t.image } : {}) }));
	}
	return o;
}

// ───────────────────────────── pintar mensajes ─────────────────────────────

function actionButton(name, title, onClick) {
	const b = el("button", "icon-btn sm");
	b.type = "button";
	b.title = title;
	b.setAttribute("aria-label", title);
	b.dataset.icon = name;
	b.innerHTML = icon(name, "sm");
	b.dataset.iconDone = "1";
	b.onclick = () => onClick(b);
	return b;
}

function buildUser(m) {
	const root = el("div", "msg user");
	const { text, images, files } = contentParts(m.content);
	if (images.length || files.length) {
		const f = el("div", "msg-files");
		for (const src of images) {
			const img = el("img");
			img.src = src;
			img.alt = "Imagen adjunta";
			img.onclick = () => lightbox(src);
			f.append(img);
		}
		for (const name of files) {
			const chip = el("span", "file-chip", `${icon("file", "sm")}<span></span>`);
			chip.querySelector("span").textContent = name;
			f.append(chip);
		}
		root.append(f);
	}
	if (text) {
		const b = el("div", `bubble${images.length || files.length ? " has-files" : ""}`);
		b.textContent = text;
		root.append(b);
	}
	const actions = el("div", "msg-actions");
	actions.append(
		actionButton("copy", "Copiar", (b) => copyText(text, b)),
		actionButton("pencil", "Editar y reenviar", () => startEdit(m)),
	);
	root.append(actions);
	refs.set(m, { root });
	return root;
}

function buildAssistant(m) {
	const root = el(
		"div",
		"msg assistant",
		`<div class="avatar"><img src="/icons/icon-64.png" alt=""></div>
		<div class="body">
			<div class="msg-author" hidden></div>
			<div class="steps" hidden><button type="button" class="steps-toggle">${icon("chevronDown", "sm")}<span></span></button><div class="steps-list"></div></div>
			<div class="approvals"></div>
			<div class="md"></div>
			<div class="extra"></div>
			<div class="msg-actions"></div>
		</div>`,
	);
	const r = {
		root,
		avatar: $(".avatar", root),
		author: $(".msg-author", root),
		steps: $(".steps", root),
		stepsLabel: $(".steps-toggle span", root),
		stepsList: $(".steps-list", root),
		approvals: $(".approvals", root),
		md: $(".md", root),
		extra: $(".extra", root),
		actions: $(".msg-actions", root),
		cards: [],
	};
	$(".steps-toggle", root).onclick = () => r.steps.classList.toggle("collapsed");
	r.actions.append(
		actionButton("copy", "Copiar", (b) => copyText(m.content, b)),
		actionButton("volume", "Leer en voz alta", (b) => readAloud(m, b)),
		actionButton("refresh", "Regenerar respuesta", () => regenerate(m)),
	);
	refs.set(m, r);
	if ((m.tools?.length ?? 0) > 3) r.steps.classList.add("collapsed");
	paintAssistant(m);
	return root;
}

function paintSteps(m) {
	const r = refs.get(m);
	if (!r?.steps) return;
	const tools = m.tools || [];
	// Solo se repinta si cambió algo (evita que las capturas parpadeen mientras llega el texto).
	const sig = JSON.stringify(tools.map((t) => [t.id, t.status, t.error, t.image]));
	if (r.stepsSig === sig) return;
	r.stepsSig = sig;
	r.steps.hidden = tools.length === 0;
	if (!tools.length) return;
	const running = tools.some((t) => t.status === "running");
	r.stepsLabel.textContent = running ? "Trabajando…" : tools.length === 1 ? "1 acción" : `${tools.length} acciones`;
	r.stepsList.innerHTML = tools
		.map((t) => {
			const ico = t.status === "running" ? "loader" : t.status === "ok" ? "check" : "x";
			return `<div class="step ${t.status}">${icon(ico, "sm")}<div class="step-text">${escapeHtml(t.label)}${t.error ? `<span class="step-error">${escapeHtml(t.error)}</span>` : ""}${t.image ? `<img class="step-shot" data-src="${escapeHtml(t.image)}" alt="Captura de pantalla">` : ""}</div></div>`;
		})
		.join("");
	for (const img of $$("img[data-src]", r.stepsList)) {
		protectedImageUrl(img.dataset.src)
			.then((u) => {
				img.src = u;
				img.onclick = () => lightbox(u);
			})
			.catch(() => img.remove());
	}
}

/** El agente de un mensaje (por su id), o uno con solo el nombre si ya no existe. */
function agentOf(m) {
	if (!m?.agent) return null;
	return state.agents.find((a) => a.id === m.agent) || { id: m.agent, name: m.agentName || m.agent };
}

/** En una sala, cada respuesta lleva el nombre y el color de quien habló. */
function paintAuthor(m) {
	const r = refs.get(m);
	if (!r?.author) return;
	const a = agentOf(m);
	const key = a ? `${a.id}|${a.name}|${agentColor(a)}` : "";
	if (r.authorKey === key) return;
	r.authorKey = key;
	r.author.hidden = !a;
	r.author.textContent = a ? a.name : "";
	if (a) r.avatar.replaceChildren(agentAvatar(a, "agent-initial"));
	else r.avatar.innerHTML = '<img src="/icons/icon-64.png" alt="">';
	r.avatar.classList.toggle("agent", Boolean(a));
	if (a) r.avatar.style.setProperty("--agent-color", agentColor(a));
}

function paintAssistant(m) {
	const r = refs.get(m);
	if (!r?.md) return;
	r.root.classList.toggle("streaming", Boolean(m.streaming));
	paintAuthor(m);
	paintSteps(m);
	const waiting = m.streaming && !m.content && !(m.tools || []).some((t) => t.status === "running") && !r.cards.some((c) => !c.done);
	if (m.content) r.md.innerHTML = renderMarkdown(m.content, { streaming: m.streaming });
	else r.md.innerHTML = waiting ? '<span class="thinking-dot" aria-label="Pensando"></span>' : "";
	r.extra.innerHTML = "";
	if (m.error) {
		r.extra.innerHTML = `<div class="msg-error">${icon("alert", "sm")}<div class="text"></div><button class="btn sm" type="button">Reintentar</button></div>`;
		$(".text", r.extra).textContent = m.error;
		$("button", r.extra).onclick = () => regenerate(m);
	} else if (m.stopped) {
		r.extra.innerHTML = '<div class="msg-note">Respuesta detenida.</div>';
	}
	r.actions.hidden = Boolean(m.error) && !m.content;
}

function renderThread() {
	messagesBox.innerHTML = "";
	for (const m of state.messages) messagesBox.append(m.role === "user" ? buildUser(m) : buildAssistant(m));
	markLast();
	updateEmpty();
}

function markLast() {
	$$(".msg.assistant.last", messagesBox).forEach((e) => e.classList.remove("last"));
	const last = [...state.messages].reverse().find((m) => m.role === "assistant");
	if (last) refs.get(last)?.root.classList.add("last");
}

function updateEmpty() {
	const empty = state.messages.length === 0;
	$("#chat-area").classList.toggle("is-empty", empty);
	const who = state.profile?.userName?.trim();
	$("#hero-title").textContent = who ? `¿En qué puedo ayudarte, ${who}?` : "¿En qué puedo ayudarte?";
	// Página de un proyecto: el cuadro de texto empieza un chat nuevo dentro de él.
	const home = inProjectHome();
	$("#chat-area").classList.toggle("project-mode", home);
	$("#project-hero").hidden = !home;
	$("#project-home").hidden = !home;
	state.placeholder ||= input.placeholder;
	input.placeholder = home ? `Nuevo chat en «${projects.store.current?.name ?? "el proyecto"}»` : state.placeholder;
	paintCrumb();
}

const inProjectHome = () => Boolean(state.projectHome && !state.activeId && state.messages.length === 0);

/** En un chat de un proyecto, la barra superior muestra el proyecto (clic: volver a su página). */
function paintCrumb() {
	const p = state.activeId ? projects.projectOfChat(state.activeId) : null;
	const crumb = $("#project-crumb");
	crumb.hidden = !p;
	if (!p) return;
	$(".crumb-name", crumb).textContent = p.name;
	crumb.onclick = () => openProject(p.id);
}

function nearBottom() {
	return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
}

function scrollToBottom(smooth = false) {
	thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

thread.addEventListener("scroll", () => $("#scroll-bottom").classList.toggle("show", !nearBottom()));
$("#scroll-bottom").onclick = () => scrollToBottom(true);

messagesBox.addEventListener("click", (e) => {
	const btn = e.target.closest(".copy-code");
	if (!btn) return;
	const code = btn.closest(".code-block")?.querySelector("code")?.innerText ?? "";
	copyText(code);
	const label = btn.querySelector("span");
	label.textContent = "Copiado";
	setTimeout(() => (label.textContent = "Copiar"), 1500);
});

// ───────────────────────────── composer ─────────────────────────────

function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.38)}px`;
}

function paintComposer() {
	const hasContent = input.value.trim().length > 0 || state.attachments.length > 0;
	$("#send-btn").hidden = state.busy || !hasContent;
	$("#voice-btn").hidden = state.busy || hasContent;
	$("#stop-btn").hidden = !state.busy;
}

function setBusy(b) {
	state.busy = b;
	paintComposer();
}

function setStatus(ok) {
	const dot = $("#status-dot");
	dot.classList.toggle("ok", ok === true);
	dot.classList.toggle("bad", ok === false);
	dot.title = ok === false ? "El último intento con el modelo falló" : ok ? "Modelo respondiendo" : "";
}

input.addEventListener("input", () => {
	autosize();
	paintComposer();
});

input.addEventListener("keydown", (e) => {
	if (e.key !== "Enter" || e.isComposing) return;
	const send = prefs.enterSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
	if (send) {
		e.preventDefault();
		$("#composer").requestSubmit();
	}
});

$("#composer").addEventListener("submit", (e) => {
	e.preventDefault();
	sendMessage();
});

// Menú de comandos al escribir "/" (public/js/commands.js).
new CommandPalette(input, $("#composer"), { onSubmit: () => $("#composer").requestSubmit() });

$("#stop-btn").onclick = () => stopGeneration();
$("#attach-btn").onclick = () => $("#file-input").click();
$("#file-input").onchange = (e) => {
	addFiles([...e.target.files]);
	e.target.value = "";
};

const TEXT_EXT = /\.(txt|md|csv|json|log|xml|ya?ml|ini|js|mjs|ts|tsx|jsx|py|html?|css|java|c|cpp|h|cs|go|rs|php|rb|sh|ps1|sql|toml|env)$/i;

async function downscaleImage(file, max = 1600, quality = 0.85) {
	const bmp = await createImageBitmap(file);
	const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
	const canvas = el("canvas");
	canvas.width = Math.round(bmp.width * scale);
	canvas.height = Math.round(bmp.height * scale);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", quality);
}

async function addFiles(files) {
	for (const f of files) {
		if (state.attachments.length >= 6) {
			toast("Máximo 6 archivos por mensaje.", "error");
			break;
		}
		try {
			if (f.type.startsWith("image/")) {
				state.attachments.push({ kind: "image", name: f.name, dataUrl: await downscaleImage(f) });
			} else if (f.type.startsWith("text/") || TEXT_EXT.test(f.name)) {
				if (f.size > 300_000) {
					toast(`${f.name} es demasiado grande (máx. 300 KB).`, "error");
					continue;
				}
				state.attachments.push({ kind: "file", name: f.name, text: await f.text() });
			} else {
				toast(`No puedo leer ${f.name}: solo imágenes y archivos de texto.`, "error");
			}
		} catch {
			toast(`No pude abrir ${f.name}.`, "error");
		}
	}
	paintAttachments();
	paintComposer();
	input.focus();
}

function paintAttachments() {
	const box = $("#attachments");
	box.innerHTML = "";
	state.attachments.forEach((a, i) => {
		const item = el("div", "attachment");
		if (a.kind === "image") {
			const img = el("img");
			img.src = a.dataUrl;
			img.alt = a.name;
			item.append(img);
		} else {
			const chip = el("span", "file-chip", `${icon("file", "sm")}<span></span>`);
			chip.querySelector("span").textContent = a.name;
			item.append(chip);
		}
		const rm = el("button", "remove", icon("x"));
		rm.type = "button";
		rm.title = "Quitar";
		rm.onclick = () => {
			state.attachments.splice(i, 1);
			paintAttachments();
			paintComposer();
		};
		item.append(rm);
		box.append(item);
	});
}

input.addEventListener("paste", (e) => {
	const files = [...(e.clipboardData?.files || [])];
	if (files.length) {
		e.preventDefault();
		addFiles(files);
	}
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
	if (!hasFiles(e)) return;
	dragDepth++;
	$("#drop-overlay").classList.add("show");
});
window.addEventListener("dragleave", (e) => {
	if (!hasFiles(e)) return;
	dragDepth = Math.max(0, dragDepth - 1);
	if (!dragDepth) $("#drop-overlay").classList.remove("show");
});
window.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
window.addEventListener("drop", (e) => {
	if (!hasFiles(e)) return;
	e.preventDefault();
	dragDepth = 0;
	$("#drop-overlay").classList.remove("show");
	// En la página de un proyecto, lo que se suelta se sube al proyecto; en un chat, se adjunta.
	if (inProjectHome()) projects.uploadFiles(state.projectHome, e.dataTransfer.files);
	else addFiles([...e.dataTransfer.files]);
});

// ───────────────────────────── enviar y recibir ─────────────────────────────

async function ensureSession() {
	if (state.activeId) return;
	const projectId = state.projectHome;
	const d = await api("/api/chat-sessions", { method: "POST", json: projectId ? { projectId } : {} });
	if (projectId) projects.noteChatInProject(projectId, d.session.id);
	state.projectHome = null;
	state.activeId = d.session.id;
	state.sessions.unshift(d.session);
	setRoute(d.session.id);
	paintSidebar();
}

async function sendMessage(textArg, opts = {}) {
	if (state.busy) return;
	const fromComposer = textArg === undefined;
	const text = (fromComposer ? input.value : textArg).trim();
	const attachments = fromComposer ? state.attachments : opts.attachments || [];
	if (!text && !attachments.length) return;
	if (fromComposer) {
		input.value = "";
		state.attachments = [];
		paintAttachments();
		autosize();
	}
	// "/nuevo" lo resuelve la propia web: abre un chat vacío.
	if (/^\/(nuevo|new|limpiar|clear|reset)$/i.test(text) && !attachments.length) {
		paintComposer();
		newChat();
		return;
	}
	stopReading();
	const m = { role: "user", content: buildContent(text, attachments), ts: Date.now() };
	state.messages.push(m);
	messagesBox.append(buildUser(m));
	updateEmpty();
	scrollToBottom();
	await runAssistant(opts);
}

/** Los errores de las tools van dirigidos al modelo; aquí se muestran en corto para la persona. */
function friendlyToolError(e = "") {
	if (/^El usuario rechazó/.test(e)) return "No diste permiso.";
	if (/approvalMode=deny/.test(e)) return "Bloqueado por tus ajustes de permisos.";
	if (/este canal no puede pedirla/.test(e)) return "Necesita tu permiso y aquí no se puede pedir.";
	return e.length > 220 ? `${e.slice(0, 217)}…` : e;
}

function applyToolEvent(m, evt) {
	m.tools ??= [];
	if (evt.phase === "start") {
		m.tools.push({ id: evt.id, name: evt.name, label: evt.label, status: "running" });
		return;
	}
	const t = m.tools.find((x) => x.id === evt.id);
	if (!t) return;
	t.status = evt.ok ? "ok" : "fail";
	if (evt.error) t.error = friendlyToolError(evt.error);
	if (evt.image) t.image = evt.image;
}

function addApprovalCard(m, evt) {
	const r = refs.get(m);
	const card = el(
		"div",
		"approval",
		`<div class="approval-head">${icon("shield", "sm")}<span></span></div><div class="approval-summary"></div><div class="approval-actions"><button class="btn primary sm" data-a="yes">Permitir</button>${evt.canRemember ? '<button class="btn sm" data-a="always">Permitir siempre en este chat</button>' : ""}<button class="btn ghost sm" data-a="no">Rechazar</button></div>`,
	);
	const who = m.agentName || state.name;
	$(".approval-head span", card).textContent = `${who} necesita tu permiso`;
	$(".approval-summary", card).textContent = evt.summary;
	const entry = { done: false, decide: null };
	const decide = async (approved, remember = false) => {
		if (entry.done) return;
		entry.done = true;
		card.className = "approval done";
		card.textContent = `${approved ? (remember ? "✓ Permitido en este chat" : "✓ Permitido") : "✗ Rechazado"} · ${evt.summary.length > 120 ? evt.summary.slice(0, 117) + "…" : evt.summary}`;
		paintAssistant(m);
		try {
			await answerApproval(evt.id, approved, remember);
		} catch (err) {
			toast(err.message, "error");
		}
	};
	entry.decide = decide;
	entry.cancel = () => {
		if (entry.done) return;
		entry.done = true;
		card.className = "approval done";
		card.textContent = "Permiso cancelado.";
	};
	card.addEventListener("click", (e) => {
		const a = e.target.closest("[data-a]")?.dataset.a;
		if (a) decide(a !== "no", a === "always");
	});
	r.approvals.append(card);
	r.cards.push(entry);
	notifySystem(`${who} necesita tu permiso`, evt.summary);
	return decide;
}

async function runAssistant({ voice = false, hooks = {} } = {}) {
	try {
		await ensureSession();
	} catch (err) {
		toast(err.message, "error");
		return;
	}
	// Se guardan el chat y su lista: si el usuario cambia de chat a mitad, esta respuesta
	// se sigue guardando en el suyo.
	const sessionId = state.activeId;
	const list = state.messages;
	const m = { role: "assistant", content: "", tools: [], ts: Date.now(), streaming: true };
	list.push(m);
	messagesBox.append(buildAssistant(m));
	markLast();
	scrollToBottom();
	setBusy(true);

	const controller = new AbortController();
	state.controller = controller;
	let raf = 0;
	const repaint = () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			const stick = nearBottom();
			paintAssistant(m);
			if (stick) scrollToBottom();
		});
	};
	// En una sala el servidor necesita saber qué agente dijo cada respuesta.
	const payload = list
		.filter((x) => x !== m && !x.error)
		.map((x) => (x.agent ? { role: x.role, content: x.content, agent: x.agent, agentName: x.agentName } : { role: x.role, content: x.content }));

	try {
		await streamChat(
			{ messages: payload, sessionId, voice },
			{
				onDelta: (full) => {
					m.content = full;
					repaint();
					hooks.onDelta?.(full);
				},
				onTool: (evt) => {
					applyToolEvent(m, evt);
					repaint();
					panels.onTool(evt);
					hooks.onTool?.(evt);
				},
				onApproval: (evt) => {
					const decide = addApprovalCard(m, evt);
					repaint();
					scrollToBottom();
					hooks.onApproval?.(evt, decide);
				},
				onAgent: (agent) => {
					setMessageAgent(m, agent);
					repaint();
					hooks.onAgent?.(agent);
				},
				onRoom: (evt) => {
					if (sessionId === state.activeId) setRoom(evt.room);
					if (evt.openVoice && !voice) setTimeout(() => voice_.open(), 0);
				},
				onDone: ({ content, agent }) => {
					if (typeof content === "string" && content) m.content = content;
					// Las órdenes de sala responden a nombre de un agente (o del asistente: null).
					if (agent !== undefined) {
						setMessageAgent(m, agent);
						hooks.onAgent?.(agent);
					}
				},
			},
			controller.signal,
		);
		setStatus(true);
	} catch (err) {
		if (controller.signal.aborted) m.stopped = true;
		else {
			m.error = err.message || String(err);
			setStatus(false);
		}
	}
	cancelAnimationFrame(raf);
	m.streaming = false;
	if (!m.error && /^\s*⚠️/.test(m.content)) {
		m.error = m.content.replace(/^\s*⚠️\s*/, "");
		m.content = "";
		setStatus(false);
	}
	for (const t of m.tools) {
		if (t.status === "running") {
			t.status = "fail";
			t.error = "Detenido";
		}
	}
	refs.get(m)?.cards.forEach((c) => c.cancel?.());
	if (m.stopped && !m.content && !m.tools.length) {
		refs.get(m)?.root.remove();
		list.splice(list.indexOf(m), 1);
	} else {
		if (m.tools.length > 3) refs.get(m)?.steps.classList.add("collapsed");
		// El pintado final colorea el código y puede crecer: se mantiene pegado al final.
		const stick = nearBottom();
		paintAssistant(m);
		if (stick && list === state.messages) scrollToBottom();
	}
	state.controller = null;
	setBusy(false);
	markLast();
	hooks.onDone?.(m);
	await persist(sessionId, list);
	if (!voice && prefs.autoRead && m.content && !m.error) readAloud(m);
}

function stopGeneration() {
	state.controller?.abort();
}

function setMessageAgent(m, agent) {
	if (agent) {
		m.agent = agent.id;
		m.agentName = agent.name;
		if (!state.agents.some((a) => a.id === agent.id)) state.agents.push(agent);
	} else {
		delete m.agent;
		delete m.agentName;
	}
}

// ───────────────────────────── salas con varios agentes ─────────────────────────────

const roomBar = $("#room-bar");

function setRoom(room) {
	state.room = room || null;
	paintRoomBar();
}

async function loadRoom(id) {
	try {
		const d = await api(`/api/rooms/${encodeURIComponent(id)}`);
		if (state.activeId === id) setRoom(d.room);
	} catch {
		setRoom(null);
	}
}

async function roomAction(action, agentId) {
	if (state.busy) return toast("Espera a que termine la respuesta.", "info");
	try {
		await ensureSession();
		const d = await api(`/api/rooms/${encodeURIComponent(state.activeId)}`, { method: "POST", json: { action, agentId } });
		setRoom(d.room);
	} catch (err) {
		toast(err.message, "error");
	}
}

function paintRoomBar() {
	const room = state.room;
	roomBar.hidden = !room && !state.agents.length;
	roomBar.innerHTML = "";
	if (roomBar.hidden) return;
	for (const p of room?.participants || []) {
		const chip = el("button", `room-chip${p.principal ? " principal" : ""}`);
		chip.type = "button";
		chip.title = p.principal ? `${p.name} responde si no nombras a otro` : `Nombra a ${p.name} para que responda`;
		chip.append(agentAvatar(p), document.createTextNode(p.name));
		if (p.principal) chip.append(el("span", "room-star", "★"));
		chip.onclick = () =>
			openMenu(chip, [
				...(p.principal ? [] : [{ label: "Hacer principal", icon: "sparkles", onClick: () => roomAction("promote", p.id) }]),
				{ label: "Quitar de la sala", icon: "x", danger: true, onClick: () => roomAction("remove", p.id) },
			]);
		roomBar.append(chip);
	}
	const others = state.agents.filter((a) => !room?.participants.some((p) => p.id === a.id));
	if (others.length) {
		const add = el("button", "room-chip add", `${icon("plus", "sm")}<span></span>`);
		add.type = "button";
		$("span", add).textContent = room ? "Sumar agente" : "Hablar con un agente";
		add.onclick = () => openMenu(add, others.map((a) => ({ label: a.name, onClick: () => roomAction("add", a.id) })));
		roomBar.append(add);
	}
}

/** Abre un chat nuevo que ya es una sala con este agente (Ajustes → Agentes, palabra de activación). */
async function openRoom(agentId, { voiceMode } = {}) {
	try {
		const d = await api("/api/rooms", { method: "POST", json: { agentId } });
		if (settingsDlg.open) settingsDlg.close();
		upsertSession(d.session);
		await openChat(d.session.id);
		setRoom(d.room);
		if (voiceMode ?? d.agent.mode === "voice") voice_.open({ greet: d.session.messages?.[0]?.content, agent: d.agent });
		return d;
	} catch (err) {
		toast(err.message, "error");
	}
}

async function refreshAgents() {
	await loadAgents();
}

async function persist(id = state.activeId, list = state.messages) {
	if (!id) return;
	const messages = list.filter((x) => !x.error && !x.streaming && (x.role === "user" || String(x.content).trim())).map(serialize);
	try {
		const d = await api(`/api/chat-sessions/${encodeURIComponent(id)}`, { method: "PUT", json: { messages } });
		upsertSession(d.session);
		if (state.activeId === id) setDocTitle(d.session.title);
		paintSidebar();
	} catch (err) {
		toast(`No se pudo guardar el chat: ${err.message}`, "error");
	}
}

function regenerate(m) {
	if (state.busy) return;
	const idx = state.messages.indexOf(m);
	if (idx < 0) return;
	state.messages = state.messages.slice(0, idx);
	renderThread();
	runAssistant();
}

function startEdit(m) {
	if (state.busy) return;
	const r = refs.get(m);
	const { text } = contentParts(m.content);
	const box = el("div", "edit-box", `<textarea aria-label="Editar mensaje"></textarea><div class="row"><button class="btn sm" data-x>Cancelar</button><button class="btn primary sm" data-ok>Enviar</button></div>`);
	const ta = $("textarea", box);
	ta.value = text;
	r.root.replaceChildren(box);
	ta.focus();
	ta.setSelectionRange(ta.value.length, ta.value.length);
	const fit = () => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	};
	fit();
	ta.oninput = fit;
	$("[data-x]", box).onclick = () => r.root.replaceWith(buildUser(m));
	const save = () => {
		const v = ta.value.trim();
		if (!v) return;
		const idx = state.messages.indexOf(m);
		state.messages = state.messages.slice(0, idx);
		state.messages.push({ role: "user", content: replaceText(m.content, v), ts: Date.now() });
		renderThread();
		runAssistant();
	};
	$("[data-ok]", box).onclick = save;
	ta.onkeydown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			save();
		} else if (e.key === "Escape") {
			e.stopPropagation();
			r.root.replaceWith(buildUser(m));
		}
	};
}

// ───────────────────────────── chats (barra lateral) ─────────────────────────────

/**
 * El título de la ventana siempre empieza por el nombre del asistente: así el control
 * de ventanas del servidor reconoce la ventana de Shiro y no la cierra por error.
 */
function setDocTitle(chatTitle = "") {
	const t = chatTitle && chatTitle !== "Nueva sesión" ? chatTitle : "";
	document.title = t ? `${state.name} · ${t}` : state.name;
}

function upsertSession(s) {
	const meta = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, lastPreview: s.lastPreview };
	const i = state.sessions.findIndex((x) => x.id === s.id);
	if (i >= 0) state.sessions[i] = meta;
	else state.sessions.unshift(meta);
}

function groupLabel(ts) {
	const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86_400_000);
	if (diff <= 0) return "Hoy";
	if (diff === 1) return "Ayer";
	if (diff < 7) return "Últimos 7 días";
	if (diff < 30) return "Últimos 30 días";
	const s = new Date(ts).toLocaleDateString("es", { month: "long", year: "numeric" });
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function paintSidebar() {
	const list = $("#chat-list");
	const q = norm(state.search.trim());
	paintCrumb();
	const activeProject = state.projectHome || projects.projectOfChat(state.activeId)?.id || null;
	$("#project-list").hidden = Boolean(q);
	if (!q) projects.paintSidebarProjects({ activeProjectId: activeProject, activeChatId: state.activeId, onHome: inProjectHome() });
	// Los chats de un proyecto se ven dentro de él; al buscar, salen todos.
	const inProjects = q ? new Set() : projects.projectChatIds();
	const sessions = state.sessions
		.filter((s) => !inProjects.has(s.id) && (!q || norm(`${s.title} ${s.lastPreview || ""}`).includes(q)))
		.sort((a, b) => b.updatedAt - a.updatedAt);
	if (!sessions.length) {
		list.innerHTML = q || !state.sessions.length ? `<div class="sb-empty">${q ? "Ningún chat coincide con la búsqueda." : "Aún no tienes chats. ¡Empieza uno!"}</div>` : "";
		return;
	}
	let html = "";
	let last = "";
	for (const s of sessions) {
		const g = groupLabel(s.updatedAt);
		if (g !== last) {
			html += `<div class="sb-group">${g}</div>`;
			last = g;
		}
		const title = !s.title || s.title === "Nueva sesión" ? "Nuevo chat" : s.title;
		html += `<div class="sb-chat${s.id === state.activeId ? " active" : ""}" data-id="${escapeHtml(s.id)}" role="listitem" tabindex="0" title="${escapeHtml(title)}"><span class="title">${escapeHtml(title)}</span><button class="icon-btn" data-menu aria-label="Opciones del chat" title="Opciones">${icon("dots", "sm")}</button></div>`;
	}
	list.innerHTML = html;
}

$("#chat-list").addEventListener("click", (e) => {
	const row = e.target.closest(".sb-chat");
	if (!row || row.querySelector(".title-input")) return;
	const id = row.dataset.id;
	if (e.target.closest("[data-menu]")) {
		chatMenu(e.target.closest("[data-menu]"), id);
		return;
	}
	openChat(id);
});

/** Menú ⋯ de un chat (barra lateral y página del proyecto). */
function chatMenu(anchor, id) {
	openMenu(anchor, [
		{ label: "Renombrar", icon: "pencil", onClick: () => startRename(id) },
		{ label: "Exportar", icon: "download", onClick: () => exportChat(id) },
		...projects.chatProjectItems(id, anchor),
		"sep",
		{ label: "Eliminar", icon: "trash", danger: true, onClick: () => deleteChat(id) },
	]);
}

$("#chat-list").addEventListener("keydown", (e) => {
	const row = e.target.closest(".sb-chat");
	if (row && e.key === "Enter" && e.target === row) openChat(row.dataset.id);
});

function startRename(id) {
	const s = state.sessions.find((x) => x.id === id);
	const row = $(`.sb-chat[data-id="${CSS.escape(id)}"]`);
	if (!s) return;
	// El chat no está en la barra lateral (p. ej. en la página de su proyecto): se renombra con una ventana.
	if (!row) return renameWithPrompt(s);
	const title = $(".title", row);
	const box = el("input", "title-input");
	box.value = s.title || "";
	box.maxLength = 120;
	title.replaceWith(box);
	box.focus();
	box.select();
	let done = false;
	const finish = async (save) => {
		if (done) return;
		done = true;
		const v = box.value.trim();
		if (save && v && v !== s.title) {
			try {
				const d = await api(`/api/chat-sessions/${encodeURIComponent(id)}`, { method: "PATCH", json: { title: v } });
				upsertSession(d.session);
				if (id === state.activeId) setDocTitle(v);
			} catch (err) {
				toast(err.message, "error");
			}
		}
		paintSidebar();
	};
	box.onkeydown = (e) => {
		if (e.key === "Enter") finish(true);
		if (e.key === "Escape") {
			e.stopPropagation();
			finish(false);
		}
	};
	box.onblur = () => finish(true);
}

async function renameWithPrompt(s) {
	const v = await promptDialog({ title: "Renombrar chat", text: "Nuevo nombre del chat:", ok: "Guardar" });
	if (!v || v === s.title) return;
	try {
		const d = await api(`/api/chat-sessions/${encodeURIComponent(s.id)}`, { method: "PATCH", json: { title: v } });
		upsertSession(d.session);
		if (s.id === state.activeId) setDocTitle(v);
		paintSidebar();
		if (inProjectHome()) projects.renderHome();
	} catch (err) {
		toast(err.message, "error");
	}
}

async function deleteChat(id) {
	const s = state.sessions.find((x) => x.id === id);
	const ok = await confirmDialog({ title: "¿Eliminar este chat?", text: `Se borrará "${s?.title || "este chat"}" para siempre.`, ok: "Eliminar", danger: true });
	if (!ok) return;
	try {
		await api(`/api/chat-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
		state.sessions = state.sessions.filter((x) => x.id !== id);
		const project = projects.projectOfChat(id);
		projects.forgetChat(id);
		if (state.activeId === id) project ? openProject(project.id) : newChat();
		else if (inProjectHome()) projects.renderHome();
		paintSidebar();
		toast("Chat eliminado");
	} catch (err) {
		toast(err.message, "error");
	}
}

async function exportChat(id) {
	try {
		const d = id === state.activeId ? { session: { title: "", messages: state.messages } } : await api(`/api/chat-sessions/${encodeURIComponent(id)}`);
		const s = d.session;
		const title = state.sessions.find((x) => x.id === id)?.title || s.title || "Chat";
		let md = `# ${title}\n\n`;
		for (const m of s.messages) {
			const { text, files, images } = contentParts(m.content);
			const extra = [...files.map((f) => `📎 ${f}`), ...images.map(() => "🖼️ (imagen)")].join("  \n");
			md += m.role === "user" ? `**Tú:**\n\n${text}${extra ? `\n\n${extra}` : ""}\n\n` : `**${m.agentName || state.name}:**\n\n${m.content}\n\n---\n\n`;
		}
		const a = el("a");
		a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
		a.download = `${title.replace(/[\\/:*?"<>|]+/g, "").slice(0, 60) || "chat"}.md`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 2000);
	} catch (err) {
		toast(err.message, "error");
	}
}

async function loadSessions() {
	try {
		const d = await api("/api/chat-sessions");
		state.sessions = d.sessions || [];
	} catch (err) {
		state.sessions = [];
		toast(err.message, "error");
	}
	paintSidebar();
}

// ───────────────────────────── navegación ─────────────────────────────

function setRoute(id) {
	const h = id ? `#/c/${encodeURIComponent(id)}` : "#/";
	if (location.hash !== h) history.pushState(null, "", h);
}

function route() {
	const m = /^#\/c\/(.+)$/.exec(location.hash);
	const p = /^#\/p\/(.+)$/.exec(location.hash);
	if (m) openChat(decodeURIComponent(m[1]), false);
	else if (p) openProject(decodeURIComponent(p[1]), false);
	else if (location.hash === "#/proyectos") openOverview(false);
	else newChat(false);
}

function pushHash(h) {
	if (location.hash !== h) history.pushState(null, "", h);
}

/** Chat (con su cuadro de texto) o la lista de proyectos. */
function showView(view) {
	state.view = view;
	$("#chat-area").hidden = view !== "chat";
	$("#projects-view").hidden = view !== "projects";
}

/** Página de un proyecto: su cabecera, el cuadro para empezar un chat y sus archivos, instrucciones y chats. */
async function openProject(id, push = true) {
	if (state.busy) stopGeneration();
	stopReading();
	closeSidebarMobile();
	try {
		const p = await projects.showHome(id);
		state.projectHome = id;
		state.activeId = null;
		state.messages = [];
		state.attachments = [];
		paintAttachments();
		showView("chat");
		renderThread();
		paintSidebar();
		document.title = `${state.name} · ${p.name}`;
		if (push) pushHash(`#/p/${encodeURIComponent(id)}`);
		input.focus();
	} catch {
		toast("No encontré ese proyecto.", "error");
		newChat();
	}
}

function openOverview(push = true) {
	if (state.busy) stopGeneration();
	closeSidebarMobile();
	state.projectHome = null;
	state.activeId = null;
	state.messages = [];
	showView("projects");
	projects.renderOverview();
	paintSidebar();
	document.title = `${state.name} · Proyectos`;
	if (push) pushHash("#/proyectos");
}

window.addEventListener("popstate", route);

async function openChat(id, push = true) {
	if (state.busy) stopGeneration();
	closeSidebarMobile();
	if (id === state.activeId && state.messages.length && state.view === "chat") return;
	try {
		const d = await api(`/api/chat-sessions/${encodeURIComponent(id)}`);
		state.projectHome = null;
		showView("chat");
		state.activeId = id;
		state.messages = (d.session.messages || []).map(fromServer);
		state.attachments = [];
		paintAttachments();
		setDocTitle(d.session.title);
		renderThread();
		requestAnimationFrame(() => scrollToBottom());
		paintSidebar();
		if (push) setRoute(id);
		state.room = null;
		paintRoomBar();
		loadRoom(id);
	} catch {
		toast("No encontré ese chat.", "error");
		newChat();
	}
}

function newChat(push = true) {
	if (state.busy) stopGeneration();
	stopReading();
	state.activeId = null;
	state.projectHome = null;
	state.messages = [];
	setRoom(null);
	showView("chat");
	renderThread();
	paintSidebar();
	closeSidebarMobile();
	setDocTitle();
	if (push) setRoute(null);
	input.focus();
}

// ───────────────────────────── barra lateral ─────────────────────────────

function toggleSidebar(force) {
	const app = $("#app");
	if (isMobile()) {
		app.classList.toggle("sb-open", force);
	} else {
		const collapsed = force === undefined ? !app.classList.contains("sb-collapsed") : !force;
		app.classList.toggle("sb-collapsed", collapsed);
		prefs.sidebarCollapsed = collapsed;
		savePrefs();
	}
}

function closeSidebarMobile() {
	if (isMobile()) $("#app").classList.remove("sb-open");
}

$("#sb-close").onclick = () => toggleSidebar(false);
$("#sb-open").onclick = () => toggleSidebar(true);
$("#sidebar-backdrop").onclick = () => toggleSidebar(false);
$("#nav-new").onclick = () => newChat();
$("#top-new").onclick = () => newChat();
$("#nav-voice").onclick = () => voice.open();
$("#nav-reminders").onclick = () => openReminders();
$("#nav-projects").onclick = () => openOverview();
$("#open-settings").onclick = () => openSettings();

function openSearch() {
	if (isMobile()) toggleSidebar(true);
	else if ($("#app").classList.contains("sb-collapsed")) toggleSidebar(true);
	$("#sb-search").classList.add("open");
	$("#search-input").focus();
	$("#search-input").select();
}

$("#nav-search").onclick = openSearch;
$("#search-input").addEventListener("input", (e) => {
	state.search = e.target.value;
	paintSidebar();
});
$("#search-input").addEventListener("keydown", (e) => {
	if (e.key === "Escape") {
		e.stopPropagation();
		state.search = "";
		e.target.value = "";
		$("#sb-search").classList.remove("open");
		paintSidebar();
		input.focus();
	}
});

// ───────────────────────────── barra superior ─────────────────────────────

$("#theme-btn").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

// Paneles Navegador y Terminal (se abren solos cuando Shiro los usa).
const panels = initPanels({ toast });

$("#chat-menu-btn").onclick = (e) => {
	const items = [];
	if (state.activeId) {
		items.push(
			{ label: "Renombrar", icon: "pencil", onClick: () => startRename(state.activeId) },
			{ label: "Exportar como Markdown", icon: "download", onClick: () => exportChat(state.activeId) },
			...projects.chatProjectItems(state.activeId, e.currentTarget),
			{ label: "Eliminar chat", icon: "trash", danger: true, onClick: () => deleteChat(state.activeId) },
			"sep",
		);
	}
	items.push({ label: "Recordatorios", icon: "bell", onClick: openReminders }, { label: "Ajustes", icon: "settings", onClick: () => openSettings() });
	openMenu(e.currentTarget, items, "right");
};

function providerLabel() {
	return state.llm?.providers?.find((p) => p.value === state.llm.provider)?.label || state.llm?.provider || "";
}

async function refreshModelInfo() {
	try {
		state.llm = await api("/api/llm-config");
	} catch {}
	$("#model-name").textContent = state.llm?.model || "sin configurar";
	$("#model-btn").title = `${providerLabel()} · ${state.llm?.model || ""}\nClic para cambiar de modelo`;
}

$("#model-btn").onclick = async (e) => {
	const anchor = e.currentTarget;
	if (openMenuEl && menuAnchor === anchor) return closeMenu();
	const menu = el(
		"div",
		"menu model-menu",
		`<div class="mm-head"></div><input type="search" placeholder="Buscar o escribir un modelo…" aria-label="Buscar modelo"><div class="mm-list"><div class="mm-empty">Cargando modelos…</div></div><div class="menu-sep"></div><button class="menu-item" data-act="test">${icon("check", "sm")}<span>Probar conexión</span></button><button class="menu-item" data-act="settings">${icon("settings", "sm")}<span>Configurar modelo…</span></button>`,
	);
	$(".mm-head", menu).textContent = providerLabel();
	showMenu(menu, anchor);
	const search = $("input", menu);
	const list = $(".mm-list", menu);
	search.focus();
	let models = [];
	let error = "";
	const paint = () => {
		const q = search.value.trim();
		const found = models.filter((n) => n.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
		let html = found
			.map(
				(n) =>
					`<button class="menu-item" data-model="${escapeHtml(n)}">${icon("sparkles", "sm")}<span>${escapeHtml(n)}</span>${n === state.llm?.model ? `<span class="check">${icon("check", "sm")}</span>` : ""}</button>`,
			)
			.join("");
		if (q && !models.includes(q)) html += `<button class="menu-item" data-model="${escapeHtml(q)}">${icon("plus", "sm")}<span>Usar «${escapeHtml(q)}»</span></button>`;
		list.innerHTML = html || `<div class="mm-empty">${escapeHtml(error || "No hay modelos en la lista. Escribe el nombre de uno.")}</div>`;
	};
	search.oninput = paint;
	search.onkeydown = (ev) => {
		if (ev.key === "Enter") $("[data-model]", list)?.click();
	};
	menu.onclick = (ev) => {
		const b = ev.target.closest("button");
		if (!b) return;
		if (b.dataset.model) switchModel(b.dataset.model);
		else if (b.dataset.act === "test") testModel();
		else if (b.dataset.act === "settings") openSettings("model");
	};
	try {
		const d = await api("/api/models");
		models = d.models || [];
		error = d.error || "";
	} catch (err) {
		error = err.message;
	}
	if (openMenuEl === menu) paint();
};

async function switchModel(name) {
	closeMenu();
	const l = state.llm;
	if (!l || name === l.model) return;
	try {
		await api("/api/llm-config", { method: "PUT", json: { provider: l.provider, model: name, baseUrl: l.baseUrl } });
		await refreshModelInfo();
		loadSettings().catch(() => {});
		setStatus(null);
		toast(`Modelo: ${name}`);
	} catch (err) {
		toast(err.message, "error");
	}
}

async function testModel(target) {
	closeMenu();
	const out = (html, kind) => {
		if (target) target.innerHTML = `<div class="notice ${kind}">${html}</div>`;
	};
	out(`${icon("loader", "sm")}<span>Probando la conexión… (la primera vez un modelo local puede tardar en cargar)</span>`, "");
	if (!target) toast("Probando la conexión con el modelo…");
	try {
		const r = await api("/api/llm-test", { method: "POST" });
		if (r.ok) {
			setStatus(true);
			out(`${icon("check", "sm")}<span>Funciona. Respondió en ${(r.ms / 1000).toFixed(1)} s.</span>`, "ok");
			if (!target) toast(`El modelo responde (${(r.ms / 1000).toFixed(1)} s)`);
		} else {
			setStatus(false);
			out(`${icon("alert", "sm")}<span>${escapeHtml(r.error)}</span>`, "bad");
			if (!target) toast(r.error, "error", 7000);
		}
	} catch (err) {
		setStatus(false);
		out(`${icon("alert", "sm")}<span>${escapeHtml(err.message)}</span>`, "bad");
		if (!target) toast(err.message, "error");
	}
}

// ───────────────────────────── identidad ─────────────────────────────

function paintIdentity() {
	$("#brand-name").textContent = state.name;
	$("#model-assistant").textContent = state.name;
	const who = state.profile?.userName?.trim() || "";
	$("#user-name").textContent = who || "Tú";
	const initials = who
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0].toUpperCase())
		.join("");
	const box = $("#user-initials");
	if (initials) box.textContent = initials;
	else box.innerHTML = icon("user", "sm");
	state.placeholder = `Pregúntale o pídele algo a ${state.name} (escribe / para ver los comandos)`;
	if (!state.activeId) setDocTitle();
	updateEmpty();
	paintSuggestions();
}

const SUGGESTIONS = [
	{ icon: "music", text: "Pon música tranquila en YouTube", pc: true },
	{ icon: "cpu", text: "¿Cómo está mi PC?", pc: true },
	{ icon: "globe", text: "¿Qué noticias hay hoy?" },
	{ icon: "bell", text: "Recuérdame tomar agua en 1 hora" },
	{ icon: "window", text: "¿Qué ventanas tengo abiertas?", pc: true },
];

function paintSuggestions() {
	const pc = state.settings?.pcControl !== false && state.settings?.autonomousMode !== false;
	const box = $("#suggestions");
	box.innerHTML = "";
	for (const s of SUGGESTIONS.filter((x) => pc || !x.pc)) {
		const b = el("button", "suggestion", `${icon(s.icon)}<span></span>`);
		b.type = "button";
		$("span", b).textContent = s.text;
		b.onclick = () => sendMessage(s.text);
		box.append(b);
	}
}

async function loadSettings() {
	const [s, llm, profile] = await Promise.all([api("/api/settings"), api("/api/llm-config"), api("/api/user-profile")]);
	state.settings = s;
	state.llm = llm;
	state.profile = profile || {};
	state.name = s.assistantName || "Shiro";
	$("#model-name").textContent = llm.model || "sin configurar";
	paintIdentity();
	return s;
}

// ───────────────────────────── ajustes ─────────────────────────────

const settingsDlg = $("#settings-dialog");
let activeTab = "general";

function selectTab(tab) {
	activeTab = tab;
	$$("#settings-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
	$$("#settings-panel section").forEach((s) => s.classList.toggle("active", s.dataset.panel === tab));
	if (tab === "connections") {
		refreshWhatsApp();
		refreshTelegram();
	}
	if (tab === "voice") paintVoices();
	if (tab === "profile") loadPrompts();
	if (tab === "agents") loadAgents();
	if (tab === "storage") mountStorageForm($("#storage-form"), { settings: true, onSaved: () => loadSessions() });
	onSettingsTab(tab);
}

$("#settings-nav").onclick = (e) => {
	const b = e.target.closest("[data-tab]");
	if (b) selectTab(b.dataset.tab);
};

for (const d of $$("dialog")) {
	d.addEventListener("click", (e) => {
		if (e.target.closest("[data-close]") || e.target === d) d.close();
	});
}

// Bienvenida del primer arranque (public/js/setup.js). Al terminar se recargan ajustes y chats
// (pueden estar en otro sitio si eligió Obsidian o Supabase).
initSetup({
	toast,
	onFinish: async () => {
		await Promise.all([loadSessions(), loadSettings().catch((err) => toast(err.message, "error"))]);
		newChat();
	},
});

$("#set-rerun-setup").onclick = () => {
	settingsDlg.close();
	openSetup();
};

// Pestañas Habilidades y Conectores MCP (public/js/extensions.js).
initExtensions({ toast, confirmDialog, openMenu, copyText });
initPrompts({ toast, confirmDialog, name: () => state.name });
initAgents({
	toast,
	confirmDialog,
	name: () => state.name,
	openRoom: (id) => openRoom(id),
	onChange: (agents) => {
		state.agents = agents;
		paintRoomBar();
		// Nombres y colores nuevos en los mensajes (sin rehacer una respuesta que está llegando).
		if (!state.busy) renderThread();
	},
});
projects.initProjects({
	toast,
	confirmDialog,
	openMenu,
	name: () => state.name,
	sessions: () => state.sessions,
	openChat: (id) => openChat(id),
	openProject: (id) => openProject(id),
	openOverview: () => openOverview(),
	chatMenu,
	onChange: () => {
		paintSidebar();
		updateEmpty();
		if (state.view === "projects") projects.renderOverview();
	},
});

async function openSettings(tab = "general") {
	closeMenu();
	closeSidebarMobile();
	selectTab(tab);
	if (!settingsDlg.open) settingsDlg.showModal();
	try {
		await loadSettings();
		fillSettings();
	} catch (err) {
		toast(err.message, "error");
	}
}

function fillSettings() {
	const s = state.settings;
	const p = state.profile || {};
	applyTheme();
	$("#set-assistant-name").value = s.assistantName;
	$("#set-autonomous").checked = s.autonomousMode;
	$("#set-enter-send").checked = prefs.enterSend;

	paintModelForm();
	paintVision();

	const v = s.voice;
	$("#set-stt-engine").value = v.sttEngine;
	$("#set-stt-url").value = v.sttBaseUrl;
	$("#set-stt-model").value = v.sttModel;
	$("#set-stt-key").value = "";
	$("#stt-key-hint").textContent = v.hasSttApiKey ? "Hay una clave guardada (déjalo vacío para mantenerla)." : "";
	$("#set-tts-engine").value = v.ttsEngine;
	$("#set-tts-url").value = v.ttsBaseUrl;
	$("#set-tts-model").value = v.ttsModel;
	$("#set-tts-voice").value = v.ttsVoice;
	$("#set-tts-key").value = "";
	$("#tts-key-hint").textContent = v.hasTtsApiKey ? "Hay una clave guardada (déjalo vacío para mantenerla)." : "";
	$("#set-lang").value = prefs.lang;
	$("#set-tts-rate").value = prefs.ttsRate;
	$("#rate-label").textContent = `${Number(prefs.ttsRate).toFixed(2)}×`;
	$("#set-autoread").checked = prefs.autoRead;
	const sup = voiceSupport();
	$("#stt-support").textContent = sup.browserStt
		? "Tu navegador reconoce voz (usa el servicio de Microsoft o Google, necesita internet)."
		: "Tu navegador no reconoce voz: usa Edge o Chrome, o un servidor Whisper.";
	paintVoiceFields();
	paintVoices();

	$("#set-pc").checked = s.pcControl;
	const radio = $(`#approval-choices input[value="${s.approvalMode}"]`);
	if (radio) radio.checked = true;
	$("#set-allowlist").value = (s.execAllowlist || []).join(", ");
	$("#pc-platform-note").innerHTML =
		s.platform === "win32"
			? ""
			: `<div class="notice warn">${icon("info", "sm")}<span>El control completo del PC funciona en Windows. En este sistema solo se pueden abrir webs, apps y archivos, y ver el estado del equipo.</span></div>`;

	$("#profile-name").value = p.userName || "";
	$("#profile-lang").value = p.language || "";
	$("#profile-about").value = p.about || "";
	$("#profile-extra").value = p.extra || "";
}

function paintVision() {
	const s = state.settings;
	$("#set-vision").value = s.vision;
	$("#vision-desc").textContent = `Si el modelo ve imágenes, ${state.name} puede mirar tu pantalla y hacer clic donde haga falta. Ahora mismo: ${s.visionActive ? "tu modelo SÍ puede ver imágenes." : "tu modelo NO puede ver imágenes."}`;
}

// Ajustes → Modelo: el formulario de public/js/modelForm.js (el mismo que la bienvenida).
let modelForm = null;
function paintModelForm() {
	if (modelForm) return modelForm.reset(state.llm);
	modelForm = mountModelForm($("#cfg-model-form"), {
		llm: state.llm,
		toast,
		promptDialog,
		settings: true,
		onModelChange: () => paintTuning(),
		onSaved: async () => {
			await refreshModelInfo();
			await loadSettings();
			paintVision();
			setStatus(null);
		},
		onTested: (ok) => setStatus(ok),
	});
	paintTuning();
}

// Ajustes de cada modelo (public/js/modelSettings.js): se vuelven a pedir al cambiar de modelo.
let tuningPanel = null;
function paintTuning() {
	const has = Boolean(modelForm?.target().model);
	$("#cfg-tuning-group").hidden = !has;
	if (!has) return;
	if (tuningPanel?.alive()) return tuningPanel.refresh();
	tuningPanel = mountModelSettings($("#cfg-tuning"), { toast, target: () => modelForm.target() });
}

async function putSettings(patch, okMessage = "Guardado") {
	try {
		state.settings = await api("/api/settings", { method: "PUT", json: patch });
		state.name = state.settings.assistantName || state.name;
		paintIdentity();
		if (okMessage) toast(okMessage);
		return true;
	} catch (err) {
		toast(err.message, "error");
		return false;
	}
}

$("#theme-seg").onclick = (e) => {
	const b = e.target.closest("[data-value]");
	if (b) setTheme(b.dataset.value);
};
$("#set-assistant-name").onchange = (e) => e.target.value.trim() && putSettings({ assistantName: e.target.value.trim() });
$("#set-autonomous").onchange = (e) => putSettings({ autonomousMode: e.target.checked });
$("#set-enter-send").onchange = (e) => {
	prefs.enterSend = e.target.checked;
	savePrefs();
};
$("#set-vision").onchange = async (e) => {
	if (await putSettings({ vision: e.target.value })) paintVision();
};
$("#set-pc").onchange = (e) => putSettings({ pcControl: e.target.checked }, e.target.checked ? "Control del PC activado" : "Control del PC desactivado");
$("#pc-save").onclick = () =>
	putSettings({
		approvalMode: $("#approval-choices input:checked")?.value || "ask",
		execAllowlist: $("#set-allowlist")
			.value.split(",")
			.map((x) => x.trim())
			.filter(Boolean),
	});

$("#profile-save").onclick = async () => {
	try {
		state.profile = await api("/api/user-profile", {
			method: "PUT",
			json: {
				userName: $("#profile-name").value.trim(),
				language: $("#profile-lang").value.trim(),
				about: $("#profile-about").value.trim(),
				extra: $("#profile-extra").value.trim(),
			},
		});
		paintIdentity();
		toast("Perfil guardado");
	} catch (err) {
		toast(err.message, "error");
	}
};

// Voz (ajustes)
function paintVoiceFields() {
	$("#stt-server-fields").hidden = $("#set-stt-engine").value !== "server";
	const server = $("#set-tts-engine").value === "server";
	$("#tts-server-fields").hidden = !server;
	$("#tts-browser-fields").hidden = server;
}

function paintVoices() {
	const sel = $("#set-tts-voice-browser");
	const voices = listVoices();
	const base = prefs.lang.slice(0, 2);
	const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(base)) - Number(a.lang.startsWith(base)) || a.name.localeCompare(b.name));
	sel.innerHTML =
		`<option value="">Automática (la mejor para ${escapeHtml(prefs.lang)})</option>` +
		sorted.map((v) => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} — ${escapeHtml(v.lang)}</option>`).join("");
	sel.value = voices.some((v) => v.voiceURI === prefs.ttsVoice) ? prefs.ttsVoice : "";
}

if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = () => settingsDlg.open && activeTab === "voice" && paintVoices();

$("#set-stt-engine").onchange = paintVoiceFields;
$("#set-tts-engine").onchange = paintVoiceFields;
$("#set-lang").onchange = (e) => {
	prefs.lang = e.target.value;
	savePrefs();
	paintVoices();
};
$("#set-tts-voice-browser").onchange = (e) => {
	prefs.ttsVoice = e.target.value;
	savePrefs();
};
$("#set-tts-rate").oninput = (e) => {
	prefs.ttsRate = Number(e.target.value);
	$("#rate-label").textContent = `${prefs.ttsRate.toFixed(2)}×`;
	savePrefs();
};
$("#set-autoread").onchange = (e) => {
	prefs.autoRead = e.target.checked;
	savePrefs();
};

function voicePatch() {
	const patch = {
		sttEngine: $("#set-stt-engine").value,
		sttBaseUrl: $("#set-stt-url").value.trim(),
		sttModel: $("#set-stt-model").value.trim() || "whisper-1",
		ttsEngine: $("#set-tts-engine").value,
		ttsBaseUrl: $("#set-tts-url").value.trim(),
		ttsModel: $("#set-tts-model").value.trim() || "tts-1",
		ttsVoice: $("#set-tts-voice").value.trim() || "alloy",
	};
	if ($("#set-stt-key").value.trim()) patch.sttApiKey = $("#set-stt-key").value.trim();
	if ($("#set-tts-key").value.trim()) patch.ttsApiKey = $("#set-tts-key").value.trim();
	return patch;
}

$("#voice-save").onclick = async () => {
	const patch = voicePatch();
	if (patch.sttEngine === "server" && !patch.sttBaseUrl) return toast("Escribe la dirección del servidor Whisper.", "error");
	if (patch.ttsEngine === "server" && !patch.ttsBaseUrl) return toast("Escribe la dirección del servidor de voz.", "error");
	if (await putSettings(patch, "Voz guardada")) fillSettings();
};

$("#tts-test").onclick = async () => {
	if ($("#set-tts-engine").value === "server") {
		if (!(await putSettings(voicePatch(), ""))) return;
	}
	const sp = new Speaker(ttsSettings);
	sp.onError = (err) => toast(`La voz falló: ${err.message}`, "error", 6000);
	sp.speak(`Hola, soy ${state.name}. Así sueno cuando te respondo.`);
};

// WhatsApp
let waTimer = 0;

async function refreshWhatsApp() {
	clearTimeout(waTimer);
	try {
		paintWhatsApp(await api("/api/whatsapp/status"));
	} catch (err) {
		$("#wa-status").textContent = err.message;
	}
}

function paintWhatsApp({ status, qrDataUrl }) {
	const labels = {
		idle: "Desconectado.",
		starting: "Iniciando… puede tardar unos segundos.",
		qr: "Escanea este código con tu móvil: WhatsApp → Dispositivos vinculados → Vincular.",
		ready: "Conectado. Ya puedes escribirle a Shiro por WhatsApp.",
		auth_failure: "Falló la vinculación. Vuelve a intentarlo.",
		disconnected: "Se desconectó.",
		error: "Hubo un error.",
	};
	const box = $("#wa-status");
	box.className = `notice ${status.state === "ready" ? "ok" : status.lastError || status.state === "error" ? "bad" : ""}`;
	box.textContent = (labels[status.state] || status.state) + (status.lastError ? ` (${status.lastError})` : "");
	const qr = $("#wa-qr");
	qr.hidden = !qrDataUrl || status.state === "ready";
	qr.innerHTML = qrDataUrl ? `<img src="${qrDataUrl}" alt="Código QR de WhatsApp">` : "";
	$("#wa-start").disabled = status.state === "ready" || status.state === "starting";
	$("#wa-stop").disabled = status.state === "idle";
	if (["starting", "qr"].includes(status.state) && settingsDlg.open && activeTab === "connections") {
		waTimer = setTimeout(refreshWhatsApp, 3000);
	}
}

$("#wa-start").onclick = async () => {
	$("#wa-status").textContent = "Iniciando…";
	try {
		paintWhatsApp(await api("/api/whatsapp/start", { method: "POST" }));
		waTimer = setTimeout(refreshWhatsApp, 2000);
	} catch (err) {
		toast(err.message, "error");
	}
};

$("#wa-stop").onclick = async () => {
	try {
		paintWhatsApp(await api("/api/whatsapp/stop", { method: "POST" }));
	} catch (err) {
		toast(err.message, "error");
	}
};

settingsDlg.addEventListener("close", () => clearTimeout(waTimer));

// Telegram
let tgTimer = 0;

async function refreshTelegram() {
	clearTimeout(tgTimer);
	try {
		paintTelegram(await api("/api/telegram/status"));
	} catch (err) {
		$("#tg-status").textContent = err.message;
	}
}

/** Fila de la lista de chats: nombre (con textContent: viene de Telegram) y un botón. */
function telegramRow(title, subtitle, buttonLabel, buttonClass, onClick) {
	const item = document.createElement("div");
	item.className = "ext-item";
	const text = document.createElement("div");
	text.className = "ext-item-text";
	const strong = document.createElement("strong");
	strong.textContent = title;
	const span = document.createElement("span");
	span.textContent = subtitle;
	text.append(strong, span);
	const btn = document.createElement("button");
	btn.className = `btn sm ${buttonClass}`;
	btn.textContent = buttonLabel;
	btn.onclick = async () => {
		btn.disabled = true;
		try {
			paintTelegram(await onClick());
		} catch (err) {
			toast(err.message, "error");
			btn.disabled = false;
		}
	};
	item.append(text, btn);
	return item;
}

function paintTelegram(s) {
	const labels = {
		idle: s.hasToken ? "Desconectado." : "Sin configurar: pega el token de tu bot y pulsa Conectar.",
		starting: "Conectando…",
		ready: `Conectado como @${s.botUsername}.` + (s.chats.length ? "" : " Escríbele /start al bot desde Telegram y autoriza tu chat aquí abajo."),
		retrying: "Sin conexión con Telegram. Reintentando…",
		error: "Hubo un error.",
	};
	const box = $("#tg-status");
	box.className = `notice ${s.state === "ready" ? "ok" : s.state === "error" ? "bad" : ""}`;
	box.textContent = (labels[s.state] || s.state) + (s.lastError ? ` (${s.lastError})` : "");
	$("#tg-token-hint").textContent = s.hasToken ? "Hay un token guardado: déjalo vacío para mantenerlo." : "";
	$("#tg-start").disabled = s.state === "ready" || s.state === "starting";
	$("#tg-stop").disabled = s.state === "idle";

	const list = $("#tg-chats");
	list.replaceChildren(
		...s.pending.map((p) =>
			telegramRow(p.name, `${p.username ? `@${p.username} · ` : ""}quiere hablar con Shiro`, "Autorizar", "primary", () =>
				api("/api/telegram/allow", { method: "POST", json: { chatId: p.id } }),
			),
		),
		...s.chats.map((c) =>
			telegramRow(c.name || c.id, "Puede hablar con Shiro", "Quitar", "", () =>
				api("/api/telegram/revoke", { method: "POST", json: { chatId: c.id } }),
			),
		),
	);
	// Mientras está conectado y a la vista, se refresca para que aparezcan las solicitudes nuevas.
	if (["starting", "ready", "retrying"].includes(s.state) && settingsDlg.open && activeTab === "connections") {
		tgTimer = setTimeout(refreshTelegram, 4000);
	}
}

$("#tg-start").onclick = async () => {
	$("#tg-status").textContent = "Conectando…";
	try {
		paintTelegram(await api("/api/telegram/start", { method: "POST", json: { token: $("#tg-token").value.trim() } }));
		$("#tg-token").value = "";
	} catch (err) {
		toast(err.message, "error", 6000);
		refreshTelegram();
	}
};

$("#tg-stop").onclick = async () => {
	try {
		paintTelegram(await api("/api/telegram/stop", { method: "POST", json: {} }));
	} catch (err) {
		toast(err.message, "error");
	}
};

settingsDlg.addEventListener("close", () => clearTimeout(tgTimer));

// ───────────────────────────── recordatorios ─────────────────────────────

const remDlg = $("#reminders-dialog");
const REPEAT = { daily: "cada día", weekly: "cada semana", monthly: "cada mes" };

function localInputValue(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openReminders() {
	closeMenu();
	closeSidebarMobile();
	const soon = new Date(Date.now() + 60 * 60 * 1000);
	soon.setMinutes(0, 0, 0);
	$("#rem-when").value = localInputValue(soon);
	remDlg.showModal();
	if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
	await loadReminders();
}

async function loadReminders() {
	const list = $("#rem-list");
	try {
		const { reminders = [] } = await api("/api/reminders");
		const sorted = reminders.sort((a, b) => Number(a.completed) - Number(b.completed) || new Date(a.datetime) - new Date(b.datetime));
		if (!sorted.length) {
			list.innerHTML = '<div class="sb-empty">No tienes recordatorios.</div>';
			return;
		}
		list.innerHTML = "";
		for (const r of sorted) {
			const item = el("div", `rem-item${r.completed ? " done" : ""}`, `${icon("bell")}<div class="info"><strong></strong><span></span></div>`);
			$("strong", item).textContent = r.title;
			const when = new Date(r.datetime).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
			$(".info span", item).textContent = `${when}${REPEAT[r.repeat] ? ` · ${REPEAT[r.repeat]}` : ""}${r.completed ? " · hecho" : ""}`;
			if (!r.completed) {
				item.append(
					actionButton("check", "Marcar como hecho", async () => {
						await api(`/api/reminders/${encodeURIComponent(r.id)}`, { method: "POST", json: { action: "complete" } }).catch((e) => toast(e.message, "error"));
						loadReminders();
					}),
				);
			}
			item.append(
				actionButton("trash", "Eliminar", async () => {
					await api(`/api/reminders/${encodeURIComponent(r.id)}`, { method: "POST", json: { action: "delete" } }).catch((e) => toast(e.message, "error"));
					loadReminders();
				}),
			);
			list.append(item);
		}
	} catch (err) {
		list.innerHTML = "";
		toast(err.message, "error");
	}
}

$("#rem-form").onsubmit = async (e) => {
	e.preventDefault();
	const when = new Date($("#rem-when").value);
	if (Number.isNaN(when.getTime())) return toast("Fecha no válida.", "error");
	try {
		await api("/api/reminders", {
			method: "POST",
			json: { title: $("#rem-title").value.trim(), datetime: when.toISOString(), repeat: $("#rem-repeat").value },
		});
		$("#rem-title").value = "";
		toast("Recordatorio creado");
		loadReminders();
	} catch (err) {
		toast(err.message, "error");
	}
};

async function pollNotifications() {
	try {
		const { notifications = [] } = await api("/api/notifications");
		for (const n of notifications) {
			toast(`Recordatorio: ${n.title}`, "bell", 12000);
			notifySystem(`⏰ ${n.title}`, n.description || "Recordatorio de Shiro");
			if (voice.active || prefs.autoRead) {
				const sp = voice.speaker || new Speaker(ttsSettings);
				sp.speak(`Recordatorio: ${n.title}`);
			}
		}
	} catch {}
}

// ───────────────────────────── voz ─────────────────────────────

/** Cómo se lee en voz alta; con un agente, con su voz (si eligió una). */
function ttsSettings(agent = null) {
	const v = state.settings?.voice;
	const av = (agent && (state.agents.find((a) => a.id === agent.id) || agent).voice) || {};
	return {
		engine: v?.ttsEngine === "server" && v.ttsBaseUrl ? "server" : "browser",
		voiceURI: av.browserVoiceURI || prefs.ttsVoice,
		rate: av.rate || prefs.ttsRate,
		lang: prefs.lang,
		serverVoice: av.serverVoice || "",
	};
}

function sttEngine() {
	const v = state.settings?.voice;
	return v?.sttEngine === "server" && v.sttBaseUrl ? "server" : "browser";
}

function canListen() {
	const sup = voiceSupport();
	return sttEngine() === "server" ? sup.recorder : sup.browserStt;
}

const NO_STT = "Este navegador no reconoce voz. Abre Shiro en Edge o Chrome, o configura un servidor Whisper en Ajustes → Voz.";

// Leer un mensaje en voz alta
const reader = { speaker: null, msg: null, btn: null };

function stopReading() {
	const { speaker, btn } = reader;
	// Primero se limpia: stop() dispara onIdle, que vuelve a llamar aquí.
	Object.assign(reader, { speaker: null, msg: null, btn: null });
	speaker?.stop();
	if (btn) {
		setIcon(btn, "volume");
		btn.classList.remove("speaking");
	}
}

function readAloud(m, btn) {
	if (reader.msg === m) return stopReading();
	stopReading();
	const sp = new Speaker(() => ttsSettings(agentOf(m)));
	sp.onError = (err) => toast(`La voz falló: ${err.message}`, "error");
	sp.onIdle = () => reader.speaker === sp && stopReading();
	const b = btn || refs.get(m)?.actions.querySelector('[data-icon="volume"]');
	Object.assign(reader, { speaker: sp, msg: m, btn: b });
	if (b) {
		setIcon(b, "pause");
		b.classList.add("speaking");
	}
	const splitter = new SentenceSplitter((s) => sp.speak(s));
	splitter.update(m.content);
	splitter.end(m.content);
	if (!sp.active) stopReading();
}

// Dictado en el cuadro de texto
let dictation = null;

async function toggleDictation() {
	if (dictation) return dictation.stop();
	if (!state.settings) await loadSettings().catch(() => {});
	if (!canListen()) return toast(NO_STT, "error", 7000);
	stopReading();
	const engine = sttEngine();
	const base = input.value;
	const sep = base && !/\s$/.test(base) ? " " : "";
	const btn = $("#dictate-btn");
	const hint = $("#dictate-hint");
	dictation = new Recognizer({
		engine,
		lang: prefs.lang,
		mode: "dictation",
		onInterim: (t) => {
			if (engine === "server") $("#dictate-text").textContent = t;
			else {
				input.value = base + sep + t;
				autosize();
			}
		},
	});
	btn.classList.add("recording");
	btn.title = "Terminar dictado";
	$("#dictate-text").textContent = "Escuchando… toca el micrófono para terminar";
	hint.classList.add("show");
	try {
		const text = await dictation.listen();
		input.value = text ? base + sep + text : base;
	} catch (err) {
		input.value = base;
		toast(err.message, "error", 7000);
	} finally {
		dictation = null;
		btn.classList.remove("recording");
		btn.title = "Dictar";
		hint.classList.remove("show");
		autosize();
		paintComposer();
		input.focus();
	}
}

$("#dictate-btn").onclick = toggleDictation;
$("#voice-btn").onclick = () => voice.open();

// Modo voz (conversación manos libres)
const orb = $("#orb");
const sphere = new HoloOrb(orb);
const voiceStatus = $("#voice-status");
const voiceTranscript = $("#voice-transcript");
const voiceApproval = $("#voice-approval");

const voice = {
	active: false,
	muted: false,
	phase: "idle",
	rec: null,
	speaker: null,
	/** Agente que está hablando (en una sala): su voz y su nombre en el título. */
	agent: null,

	/** greet: texto que se dice al abrir (el saludo de un agente recién activado). */
	async open({ greet = "", agent = null } = {}) {
		if (this.active) return;
		if (!state.settings) await loadSettings().catch(() => {});
		if (!canListen()) return toast(NO_STT, "error", 7000);
		closeMenu();
		stopReading();
		if (dictation) dictation.cancel();
		this.active = true;
		this.muted = false;
		const lastAgent = [...state.messages].reverse().find((x) => x.role === "assistant");
		this.agent = agent || (state.room ? agentOf(lastAgent) || state.room.participants.find((p) => p.principal) || null : null);
		this.speaker = new Speaker(() => ttsSettings(this.agent));
		this.speaker.onStart = () => this.phase !== "approval" && this.set("speaking", "Hablando… toca el círculo para interrumpir");
		this.speaker.onError = (err) => toast(`La voz falló: ${err.message}`, "error", 6000);
		// Si termina de leer una frase y el modelo aún escribe, no dice "Hablando".
		this.speaker.onIdle = () => this.active && state.busy && this.phase === "speaking" && this.set("thinking", "Pensando…");
		this.paintTitle();
		voiceTranscript.textContent = "";
		voiceApproval.innerHTML = "";
		$("#voice-overlay").hidden = false;
		document.body.classList.add("voice-open");
		sphere.start();
		this.paintMute();
		if (greet) {
			voiceTranscript.textContent = greet;
			this.speaker.speak(greet);
			this.set("speaking", "Hablando… toca el círculo para interrumpir");
			this.speaker.drain().then(() => this.active && this.loop());
		} else this.loop();
	},

	paintTitle() {
		$("#voice-title").textContent = `Modo voz · ${this.agent?.name || state.name}`;
	},

	setAgent(agent) {
		this.agent = agent || null;
		if (this.active) this.paintTitle();
	},

	close() {
		if (!this.active) return;
		this.active = false;
		this.rec?.cancel();
		this.speaker?.stop();
		if (state.busy) stopGeneration();
		$("#voice-overlay").hidden = true;
		document.body.classList.remove("voice-open");
		sphere.stop();
		input.focus();
	},

	set(phase, text) {
		this.phase = phase;
		orb.dataset.state = phase;
		sphere.setState(phase);
		voiceStatus.textContent = text;
	},

	paintMute() {
		const b = $("#voice-mute");
		b.classList.toggle("muted", this.muted);
		setIcon(b, this.muted ? "micOff" : "mic");
		b.title = this.muted ? "Activar micrófono" : "Pausar micrófono";
	},

	toggleMute() {
		this.muted = !this.muted;
		if (this.muted) this.rec?.cancel();
		this.paintMute();
	},

	listenOnce() {
		this.rec = new Recognizer({
			engine: sttEngine(),
			lang: prefs.lang,
			mode: "turn",
			onInterim: (t) => (voiceTranscript.textContent = t),
			onLevel: (l) => sphere.setLevel(l),
		});
		return this.rec.listen().finally(() => {
			this.rec = null;
			sphere.setLevel(0);
		});
	},

	async loop() {
		while (this.active) {
			if (this.muted) {
				this.set("paused", "Micrófono en pausa · toca el círculo para hablar");
				await waitFor(() => !this.muted || !this.active);
				continue;
			}
			this.set("listening", "Te escucho…");
			let text = "";
			try {
				text = await this.listenOnce();
			} catch (err) {
				if (!this.active) break;
				this.set("idle", err.message);
				toast(err.message, "error", 8000);
				this.muted = true;
				this.paintMute();
				continue;
			}
			if (!this.active) break;
			if (!text || this.muted) continue;
			voiceTranscript.textContent = text;
			await this.respond(text);
		}
	},

	async respond(text) {
		this.set("thinking", "Pensando…");
		const splitter = new SentenceSplitter((s) => this.speaker.speak(s));
		await sendMessage(text, {
			voice: true,
			hooks: {
				onDelta: (full) => {
					splitter.update(full);
					const plain = toSpeechText(full);
					voiceTranscript.textContent = plain.length > 320 ? `…${plain.slice(-320)}` : plain;
				},
				onTool: (evt) => {
					if (evt.phase === "start" && this.phase !== "speaking") this.set("thinking", `${evt.label}…`);
				},
				onApproval: (evt, decide) => this.askApproval(evt, decide),
				// En una sala habla quien responde: su voz y su nombre.
				onAgent: (agent) => this.setAgent(agent),
				onDone: (m) => {
					if (m.error) this.speaker.speak(`Hubo un problema. ${m.error}`);
					else if (!m.stopped) splitter.end(m.content);
				},
			},
		});
		if (!this.active) return;
		await this.speaker.drain();
	},

	async askApproval(evt, decide) {
		if (!this.active) return;
		this.set("approval", "Necesito tu permiso");
		let settled = false;
		const card = el(
			"div",
			"approval",
			`<div class="approval-summary"></div><div class="approval-actions" style="justify-content:center"><button class="btn primary" data-a="yes">Sí, hazlo</button>${evt.canRemember ? '<button class="btn" data-a="always">Sí, siempre en este chat</button>' : ""}<button class="btn" data-a="no">No</button></div>`,
		);
		$(".approval-summary", card).textContent = evt.summary;
		voiceApproval.replaceChildren(card);
		const finish = (approved, remember = false) => {
			if (settled) return;
			settled = true;
			this.rec?.cancel();
			voiceApproval.innerHTML = "";
			decide(approved, remember);
			this.set("thinking", approved ? "Hecho, sigo…" : "Vale, no lo hago.");
		};
		card.onclick = (e) => {
			const a = e.target.closest("[data-a]")?.dataset.a;
			if (a) finish(a !== "no", a === "always");
		};
		this.speaker.speak(`Necesito tu permiso para: ${evt.summary}. ¿Lo hago?`);
		await this.speaker.drain();
		for (let tries = 0; tries < 2 && !settled && this.active; tries++) {
			this.set("approval", "¿Sí o no?");
			let answer = "";
			try {
				answer = await this.listenOnce();
			} catch {
				break;
			}
			if (settled) break;
			const yn = parseYesNo(answer);
			if (yn !== null) {
				finish(yn);
				break;
			}
			if (answer) {
				this.speaker.speak("No te entendí. ¿Sí o no?");
				await this.speaker.drain();
			}
		}
		if (!settled && this.active) this.set("approval", "Toca Sí o No");
	},

	tap() {
		if (this.phase === "speaking" || this.phase === "thinking") {
			this.speaker.stop();
			if (state.busy) stopGeneration();
		} else if (this.phase === "listening" || this.phase === "approval") {
			this.rec?.stop();
		} else if (this.muted || this.phase === "paused" || this.phase === "idle") {
			this.muted = false;
			this.paintMute();
		}
	},
};

/** El modo voz, para el código de arriba que lo usa antes de definirse. */
voice_ = voice;
orb.onclick = () => voice.tap();
$("#voice-mute").onclick = () => voice.toggleMute();
$("#voice-end").onclick = () => voice.close();
$("#voice-close").onclick = () => voice.close();

// ───────────────────────────── atajos de teclado ─────────────────────────────

const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

document.addEventListener("keydown", (e) => {
	const mod = e.ctrlKey || e.metaKey;
	const k = e.key.toLowerCase();
	if (mod && e.shiftKey && k === "o") {
		e.preventDefault();
		newChat();
	} else if (mod && !e.shiftKey && k === "k") {
		e.preventDefault();
		openSearch();
	} else if (mod && e.shiftKey && e.code === "Space") {
		e.preventDefault();
		voice.active ? voice.close() : voice.open();
	} else if (e.key === "Escape") {
		if (voice.active) return voice.close();
		if (openMenuEl) return closeMenu();
		if (document.querySelector("dialog[open]")) return;
		if (state.busy) stopGeneration();
		else if (reader.msg) stopReading();
	} else if (e.key === "/" && !mod && !isTyping(e.target) && !document.querySelector("dialog[open]")) {
		e.preventDefault();
		input.focus();
	}
});

window.addEventListener("resize", () => {
	if (openMenuEl) closeMenu();
});

// ───────────────────────────── inicio ─────────────────────────────

async function init() {
	hydrateIcons();
	applyTheme();
	if (prefs.sidebarCollapsed && !isMobile()) $("#app").classList.add("sb-collapsed");
	paintComposer();
	paintSuggestions();
	await Promise.all([projects.loadProjects(), loadSessions(), loadSettings().catch((err) => toast(err.message, "error")), refreshAgents()]);
	route();
	if (state.settings?.needsSetup) openSetup({ firstRun: true });
	setInterval(pollNotifications, 20_000);
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
	input.focus();
}

init();
