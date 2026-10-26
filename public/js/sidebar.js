// Barra lateral (chats, búsqueda), navegación entre chats y proyectos, y barra superior (modelo, menú del chat).
import * as projects from "./projects.js";
import { icon } from "./icons.js";
import { api } from "./api.js";
import { escapeHtml } from "./markdown.js";
import { promptDialog } from "./extensions.js";
import { initPanels } from "./panels.js";
import { $, closeMenu, confirmDialog, el, isMobile, menuAnchor, norm, openMenu, openMenuEl, prefs, savePrefs, setTheme, showMenu, toast } from "./ui.js";
import { input, state } from "./state.js";
import { contentParts, fromServer, inProjectHome, paintCrumb, renderThread, scrollToBottom } from "./messages.js";
import { paintAttachments, setStatus, stopGeneration } from "./chat.js";
import { loadRoom, paintRoomBar, setRoom } from "./rooms.js";
import { loadSettings, openSettings } from "./settings.js";
import { openReminders } from "./reminders.js";
import { stopReading, voice } from "./voiceMode.js";

// ───────────────────────────── chats (barra lateral) ─────────────────────────────

/**
 * El título de la ventana siempre empieza por el nombre del asistente: así el control
 * de ventanas del servidor reconoce la ventana de Shiro y no la cierra por error.
 */
export function setDocTitle(chatTitle = "") {
	const t = chatTitle && chatTitle !== "Nueva sesión" ? chatTitle : "";
	document.title = t ? `${state.name} · ${t}` : state.name;
}

export function upsertSession(s) {
	const meta = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, lastPreview: s.lastPreview };
	const i = state.sessions.findIndex((x) => x.id === s.id);
	if (i >= 0) state.sessions[i] = meta;
	else state.sessions.unshift(meta);
}

export function groupLabel(ts) {
	const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86_400_000);
	if (diff <= 0) return "Hoy";
	if (diff === 1) return "Ayer";
	if (diff < 7) return "Últimos 7 días";
	if (diff < 30) return "Últimos 30 días";
	const s = new Date(ts).toLocaleDateString("es", { month: "long", year: "numeric" });
	return s.charAt(0).toUpperCase() + s.slice(1);
}

export function paintSidebar() {
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

/** Menú ⋯ de un chat (barra lateral y página del proyecto). */
export function chatMenu(anchor, id) {
	openMenu(anchor, [
		{ label: "Renombrar", icon: "pencil", onClick: () => startRename(id) },
		{ label: "Exportar", icon: "download", onClick: () => exportChat(id) },
		...projects.chatProjectItems(id, anchor),
		"sep",
		{ label: "Eliminar", icon: "trash", danger: true, onClick: () => deleteChat(id) },
	]);
}

export function startRename(id) {
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

export async function renameWithPrompt(s) {
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

export async function deleteChat(id) {
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

export async function exportChat(id) {
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

export async function loadSessions() {
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

export function setRoute(id) {
	const h = id ? `#/c/${encodeURIComponent(id)}` : "#/";
	if (location.hash !== h) history.pushState(null, "", h);
}

export function route() {
	const m = /^#\/c\/(.+)$/.exec(location.hash);
	const p = /^#\/p\/(.+)$/.exec(location.hash);
	if (m) openChat(decodeURIComponent(m[1]), false);
	else if (p) openProject(decodeURIComponent(p[1]), false);
	else if (location.hash === "#/proyectos") openOverview(false);
	else newChat(false);
}

export function pushHash(h) {
	if (location.hash !== h) history.pushState(null, "", h);
}

/** Chat (con su cuadro de texto) o la lista de proyectos. */
export function showView(view) {
	state.view = view;
	$("#chat-area").hidden = view !== "chat";
	$("#projects-view").hidden = view !== "projects";
}

/** Página de un proyecto: su cabecera, el cuadro para empezar un chat y sus archivos, instrucciones y chats. */
export async function openProject(id, push = true) {
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

export function openOverview(push = true) {
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

export async function openChat(id, push = true) {
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

export function newChat(push = true) {
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

export function toggleSidebar(force) {
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

export function closeSidebarMobile() {
	if (isMobile()) $("#app").classList.remove("sb-open");
}

export function openSearch() {
	if (isMobile()) toggleSidebar(true);
	else if ($("#app").classList.contains("sb-collapsed")) toggleSidebar(true);
	$("#sb-search").classList.add("open");
	$("#search-input").focus();
	$("#search-input").select();
}
// ───────────────────────────── barra superior ─────────────────────────────

// Paneles Navegador y Terminal (se abren solos cuando Shiro los usa).
export const panels = initPanels({ toast });

export function providerLabel() {
	return state.llm?.providers?.find((p) => p.value === state.llm.provider)?.label || state.llm?.provider || "";
}

export async function refreshModelInfo() {
	try {
		state.llm = await api("/api/llm-config");
	} catch {}
	$("#model-name").textContent = state.llm?.model || "sin configurar";
	$("#model-btn").title = `${providerLabel()} · ${state.llm?.model || ""}\nClic para cambiar de modelo`;
}

export async function switchModel(name) {
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

export async function testModel(target) {
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

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initSidebar() {
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
	$("#chat-list").addEventListener("keydown", (e) => {
		const row = e.target.closest(".sb-chat");
		if (row && e.key === "Enter" && e.target === row) openChat(row.dataset.id);
	});
	window.addEventListener("popstate", route);
	$("#sb-close").onclick = () => toggleSidebar(false);
	$("#sb-open").onclick = () => toggleSidebar(true);
	$("#sidebar-backdrop").onclick = () => toggleSidebar(false);
	$("#nav-new").onclick = () => newChat();
	$("#top-new").onclick = () => newChat();
	$("#nav-voice").onclick = () => voice.open();
	$("#nav-reminders").onclick = () => openReminders();
	$("#nav-projects").onclick = () => openOverview();
	$("#open-settings").onclick = () => openSettings();
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
	$("#theme-btn").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
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
}
