// Proyectos: la página de cada proyecto (archivos, instrucciones y sus chats), la lista de
// proyectos y su sección en la barra lateral. El chat en sí lo lleva app.js.

import { api, authFetch } from "./api.js";
import { promptDialog } from "./extensions.js";
import { icon } from "./icons.js";

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Ayudas de app.js: toast, confirmDialog, openMenu, sessions() (metas de los chats),
 * openChat(id), openProject(id), openOverview(), chatMenu(anchor, chatId), onChange().
 */
let ui = null;

/** Proyectos (resúmenes) y el que está abierto en su página (completo). */
export const store = { list: [], current: null, canPickFolder: false };

const MAX_UPLOAD = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 1000;
/**
 * Al subir una carpeta no se suben lo oculto (.git, .next…), las dependencias ni lo compilado:
 * las mismas carpetas que se saltan al vincular (SKIP_DIRS en src/core/projects/projects.ts).
 */
const SKIP_UPLOAD = new Set(["node_modules", "dist", "build", "out", "target", "bin", "obj", "coverage", "vendor", "__pycache__", "venv"]);

/** true si el archivo va dentro de una carpeta oculta, de dependencias o compilada. */
function skipUpload(f) {
	const parts = (f.webkitRelativePath || f.name).split("/");
	return parts.some((s) => s.startsWith(".")) || parts.slice(0, -1).some((s) => SKIP_UPLOAD.has(s));
}
const READABLE =
	/\.(txt|md|markdown|csv|tsv|json|jsonc|log|xml|ya?ml|ini|cfg|conf|toml|env|m?js|cjs|ts|tsx|jsx|py|html?|css|scss|java|c|cpp|h|hpp|cs|go|rs|php|rb|sh|bat|ps1|sql|kt|swift|lua|r|tex|rst|vue|svelte|pdf|docx)$/i;

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

function formatSize(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ───────────────────────────── datos ─────────────────────────────

export async function loadProjects() {
	try {
		const d = await api("/api/projects");
		store.list = d.projects || [];
		store.canPickFolder = Boolean(d.canPickFolder);
	} catch (err) {
		store.list = [];
		// Un Shiro abierto de antes de los proyectos no conoce /api/projects: no es un error para el usuario.
		if (err.status !== 404) ui?.toast(err.message, "error");
	}
}

export const findProject = (id) => store.list.find((p) => p.id === id) ?? null;
export const projectOfChat = (chatId) => (chatId ? store.list.find((p) => p.chats.includes(chatId)) ?? null : null);
export const projectChatIds = () => new Set(store.list.flatMap((p) => p.chats));

function upsertSummary(p) {
	const s = { id: p.id, name: p.name, description: p.description, chats: p.chats, createdAt: p.createdAt, updatedAt: p.updatedAt };
	const i = store.list.findIndex((x) => x.id === p.id);
	if (i >= 0) store.list[i] = s;
	else store.list.unshift(s);
}

/** Marca un chat recién creado como del proyecto (el servidor ya lo guardó). */
export function noteChatInProject(projectId, chatId) {
	const p = findProject(projectId);
	if (p && !p.chats.includes(chatId)) p.chats.unshift(chatId);
	if (store.current?.id === projectId && !store.current.chats.includes(chatId)) store.current.chats.unshift(chatId);
}

/** El chat se borró: se quita de su proyecto (el servidor ya lo hizo). */
export function forgetChat(chatId) {
	for (const p of store.list) p.chats = p.chats.filter((c) => c !== chatId);
	if (store.current) store.current.chats = store.current.chats.filter((c) => c !== chatId);
}

async function refreshCurrent() {
	if (!store.current) return;
	const d = await api(`/api/projects/${encodeURIComponent(store.current.id)}`);
	store.current = d.project;
	upsertSummary(d.project);
	renderHome();
}

// ───────────────────────────── ventanas ─────────────────────────────

/** Ventana con varios campos. Devuelve { campo: valor } o null si se cancela. */
function formDialog({ title, text: desc = "", fields, ok = "Guardar", wide = false }) {
	return new Promise((resolve) => {
		const d = el("dialog");
		d.style.width = wide ? "640px" : "480px";
		const form = el("form", "", `<h2 style="margin:0 0 8px;font:600 18px/1.3 var(--font-display)"></h2>`);
		form.method = "dialog";
		form.style.padding = "22px 24px 18px";
		$("h2", form).textContent = title;
		if (desc) {
			const p = text("p", "", desc);
			p.style.cssText = "margin:0 0 14px;color:var(--text-2);font-size:14px";
			form.append(p);
		}
		const inputs = {};
		for (const f of fields) {
			const label = el("label", "field");
			label.append(text("span", "", f.label));
			const inp = f.rows ? el("textarea", "textarea") : el("input", "input");
			if (f.rows) inp.rows = f.rows;
			inp.value = f.value || "";
			inp.placeholder = f.placeholder || "";
			if (f.max) inp.maxLength = f.max;
			if (f.required) inp.required = true;
			label.append(inp);
			if (f.hint) label.append(text("small", "", f.hint));
			form.append(label);
			inputs[f.name] = inp;
		}
		const actions = el("div", "actions-row", `<button type="button" class="btn" data-v="0">Cancelar</button><button class="btn primary" type="submit"></button>`);
		actions.style.cssText = "justify-content:flex-end;margin-top:16px";
		$('[type="submit"]', actions).textContent = ok;
		form.append(actions);
		d.append(form);
		document.body.append(d);
		const done = (v) => {
			d.close();
			d.remove();
			resolve(v);
		};
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			done(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])));
		});
		$('[data-v="0"]', actions).onclick = () => done(null);
		d.addEventListener("cancel", (e) => {
			e.preventDefault();
			done(null);
		});
		d.showModal();
		inputs[fields[0].name].focus();
	});
}

/** Crea un proyecto y lo abre. Devuelve el proyecto o null. */
export async function newProjectDialog({ open = true } = {}) {
	const v = await formDialog({
		title: "Nuevo proyecto",
		text: `Un proyecto junta chats, archivos e instrucciones sobre un mismo tema. ${ui.name()} los tiene en cuenta en todos los chats del proyecto.`,
		fields: [
			{ name: "name", label: "Nombre", placeholder: "Mi tesis, la tienda, el viaje a Japón…", max: 80, required: true },
			{ name: "description", label: "Descripción (opcional)", placeholder: "De qué trata", max: 500 },
		],
		ok: "Crear proyecto",
	});
	if (!v) return null;
	try {
		const d = await api("/api/projects", { method: "POST", json: v });
		upsertSummary(d.project);
		ui.onChange();
		if (open) ui.openProject(d.project.id);
		return d.project;
	} catch (err) {
		ui.toast(err.message, "error");
		return null;
	}
}

async function editProject(id) {
	const p = store.current?.id === id ? store.current : findProject(id);
	if (!p) return;
	const v = await formDialog({
		title: "Editar proyecto",
		fields: [
			{ name: "name", label: "Nombre", value: p.name, max: 80, required: true },
			{ name: "description", label: "Descripción", value: p.description, max: 500 },
		],
	});
	if (!v) return;
	try {
		const d = await api(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", json: v });
		upsertSummary(d.project);
		if (store.current?.id === id) store.current = d.project;
		renderHome();
		renderOverview();
		ui.onChange();
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function editInstructions() {
	const p = store.current;
	if (!p) return;
	const v = await formDialog({
		title: "Instrucciones del proyecto",
		text: `${ui.name()} las sigue en todos los chats de «${p.name}». Por ejemplo: para quién es, el tono, el formato o qué debe tener siempre en cuenta.`,
		fields: [{ name: "instructions", label: "Instrucciones", value: p.instructions, rows: 12, max: 8000, placeholder: "Responde en un tono formal. Es mi tesis de máster sobre energías renovables: cita siempre el documento del que sacas cada dato." }],
		wide: true,
	});
	if (!v) return;
	try {
		const d = await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "PATCH", json: v });
		store.current = d.project;
		renderHome();
		ui.toast("Instrucciones guardadas");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function deleteProject(id) {
	const p = findProject(id);
	if (!p) return;
	const ok = await ui.confirmDialog({
		title: `¿Eliminar «${p.name}»?`,
		text: "Se borran el proyecto, sus instrucciones y las copias de los archivos subidos. Tus carpetas vinculadas no se tocan y sus chats pasan a la lista normal.",
		ok: "Eliminar",
		danger: true,
	});
	if (!ok) return;
	try {
		await api(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
		store.list = store.list.filter((x) => x.id !== id);
		const wasOpen = store.current?.id === id;
		if (wasOpen) store.current = null;
		ui.toast("Proyecto eliminado");
		ui.onChange();
		renderOverview();
		if (wasOpen) ui.openOverview();
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function projectMenu(anchor, id) {
	ui.openMenu(
		anchor,
		[
			{ label: "Editar nombre y descripción", icon: "pencil", onClick: () => editProject(id) },
			"sep",
			{ label: "Eliminar proyecto", icon: "trash", danger: true, onClick: () => deleteProject(id) },
		],
		"right",
	);
}

// ───────────────────────────── chats ─────────────────────────────

async function setChatProject(chatId, projectId) {
	const current = projectOfChat(chatId);
	try {
		if (projectId) await api(`/api/projects/${encodeURIComponent(projectId)}/chats`, { method: "POST", json: { chatId } });
		else if (current) await api(`/api/projects/${encodeURIComponent(current.id)}/chats`, { method: "DELETE", json: { chatId } });
		await loadProjects();
		if (store.current) store.current.chats = findProject(store.current.id)?.chats ?? store.current.chats;
		renderHome();
		ui.onChange();
		ui.toast(projectId ? `Movido a «${findProject(projectId)?.name ?? "el proyecto"}»` : "El chat ya no está en el proyecto");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

/** Opciones del menú ⋯ de un chat para meterlo en un proyecto o sacarlo. */
export function chatProjectItems(chatId, anchor) {
	const current = projectOfChat(chatId);
	const items = [{ label: current ? "Mover a otro proyecto" : "Mover a un proyecto", icon: "folder", onClick: () => moveChatMenu(anchor, chatId) }];
	if (current) items.push({ label: `Sacar de «${current.name}»`, icon: "x", onClick: () => setChatProject(chatId, null) });
	return items;
}

function moveChatMenu(anchor, chatId) {
	const current = projectOfChat(chatId);
	const items = store.list.filter((p) => p.id !== current?.id).map((p) => ({ label: p.name, icon: "folder", onClick: () => setChatProject(chatId, p.id) }));
	if (items.length) items.push("sep");
	items.push({
		label: "Nuevo proyecto…",
		icon: "folderPlus",
		onClick: async () => {
			const p = await newProjectDialog({ open: false });
			if (p) setChatProject(chatId, p.id);
		},
	});
	// El ancla puede haber desaparecido al cerrarse el primer menú: se usa si sigue en la página.
	ui.openMenu(document.body.contains(anchor) ? anchor : $("#chat-menu-btn"), items, "right");
}

// ───────────────────────────── archivos ─────────────────────────────

/** Sube archivos (o una carpeta entera: usan webkitRelativePath) al proyecto. */
export async function uploadFiles(projectId, files) {
	const list = [...files].filter((f) => !skipUpload(f));
	if (!list.length) return;
	if (list.length > MAX_UPLOAD_FILES) {
		// Una carpeta así (un programa, años de documentos…) no se copia: se vincula y se lee directamente.
		const link = await ui.confirmDialog({
			title: "Es mejor vincular esta carpeta",
			text: `Tiene ${list.length.toLocaleString("es")} archivos (sin contar dependencias ni lo compilado) y solo se pueden subir ${MAX_UPLOAD_FILES} de una vez. Si la vinculas, ${ui.name()} la lee directamente desde tu PC, sin copiar nada, y ve tus cambios al momento.`,
			ok: "Vincular la carpeta",
		});
		if (link && store.current?.id === projectId) linkFolder();
		return;
	}
	const tooBig = list.filter((f) => f.size > MAX_UPLOAD);
	const queue = list.filter((f) => f.size <= MAX_UPLOAD);
	const status = $("#ph-upload-status");
	const failed = [];
	const total = queue.length;
	let done = 0;
	const paint = () => {
		if (!status) return;
		status.hidden = false;
		status.textContent = `Subiendo ${done} de ${total}…`;
	};
	paint();
	const worker = async () => {
		for (let f = queue.shift(); f; f = queue.shift()) {
			const rel = f.webkitRelativePath || f.name;
			try {
				const r = await authFetch(`/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(rel)}`, {
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: f,
				});
				if (!r.ok) failed.push(`${f.name}: ${(await r.json().catch(() => ({}))).error || `error ${r.status}`}`);
			} catch {
				failed.push(`${f.name}: sin conexión con Shiro`);
			}
			done++;
			paint();
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	if (status) status.hidden = true;
	const unreadable = list.filter((f) => f.size <= MAX_UPLOAD && !READABLE.test(f.name)).length;
	if (failed.length) ui.toast(`No pude subir ${plural(failed.length, "archivo", "archivos")}. ${failed[0]}`, "error", 7000);
	if (tooBig.length) ui.toast(`${tooBig[0].name}${tooBig.length > 1 ? ` y ${tooBig.length - 1} más` : ""}: demasiado grande (máx. 25 MB).`, "error", 6000);
	if (total - failed.length > 0) ui.toast(`${plural(total - failed.length, "archivo subido", "archivos subidos")}`);
	if (unreadable) ui.toast(`${plural(unreadable, "archivo no es", "archivos no son")} de texto, PDF ni Word: ${ui.name()} no podrá leerlos.`, "info", 6000);
	if (store.current?.id === projectId) await refreshCurrent().catch(() => {});
}

function pickFiles(folder) {
	const inp = el("input");
	inp.type = "file";
	inp.multiple = true;
	if (folder) inp.webkitdirectory = true;
	inp.onchange = () => {
		if (store.current && inp.files.length) uploadFiles(store.current.id, inp.files);
	};
	inp.click();
}

async function linkFolder() {
	const p = store.current;
	if (!p) return;
	let path = null;
	if (store.canPickFolder) {
		ui.toast("Elige la carpeta en la ventana que se ha abierto…", "info", 5000);
		try {
			const d = await api("/api/projects/pick-folder", { method: "POST" });
			if (d.cancelled) return;
			path = d.path;
		} catch {
			// Si el selector de Windows falla, se escribe la ruta a mano.
		}
	}
	path ??= await promptDialog({
		title: "Vincular una carpeta",
		text: `${ui.name()} leerá los archivos de esta carpeta tal como estén en cada momento. Para cambiar o crear archivos te pedirá permiso.`,
		placeholder: "C:\\Users\\tu-usuario\\Documents\\Mi proyecto",
		ok: "Vincular",
	});
	if (!path) return;
	try {
		const d = await api(`/api/projects/${encodeURIComponent(p.id)}/folders`, { method: "POST", json: { path } });
		store.current = d.project;
		renderHome();
		ui.toast("Carpeta vinculada");
	} catch (err) {
		ui.toast(err.message, "error", 6000);
	}
}

async function unlinkFolder(folder) {
	const ok = await ui.confirmDialog({ title: "¿Quitar esta carpeta del proyecto?", text: `No se borra nada de tu PC: ${folder.path} solo deja de estar en el proyecto.`, ok: "Quitar" });
	if (!ok) return;
	try {
		const d = await api(`/api/projects/${encodeURIComponent(store.current.id)}/folders`, { method: "DELETE", json: { path: folder.path } });
		store.current = d.project;
		renderHome();
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function removeUpload(item) {
	const ok = await ui.confirmDialog({
		title: `¿Quitar ${item.kind === "folder" ? "la carpeta" : ""} «${item.name}»?`,
		text: item.kind === "folder" ? `Se borra la copia subida (${plural(item.files, "archivo", "archivos")}).` : "Se borra la copia subida al proyecto.",
		ok: "Quitar",
		danger: true,
	});
	if (!ok) return;
	try {
		const d = await api(`/api/projects/${encodeURIComponent(store.current.id)}/files`, { method: "DELETE", json: { path: item.name } });
		store.current = d.project;
		renderHome();
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function addMenu(anchor) {
	ui.openMenu(anchor, [
		{ label: "Subir archivos", icon: "upload", onClick: () => pickFiles(false) },
		{ label: "Subir una carpeta (copia)", icon: "folder", onClick: () => pickFiles(true) },
		"sep",
		{ label: store.canPickFolder ? "Vincular una carpeta del PC (mejor para programas)…" : "Vincular una carpeta (ruta)…", icon: "link", onClick: linkFolder },
	]);
}

// ───────────────────────────── página del proyecto ─────────────────────────────

/** Carga y pinta la página de un proyecto. Lanza si no existe. */
export async function showHome(id) {
	const d = await api(`/api/projects/${encodeURIComponent(id)}`);
	store.current = d.project;
	upsertSummary(d.project);
	renderHome();
	return d.project;
}

function fileRow({ iconName, name, meta, warn = "", onRemove, removeLabel }) {
	const row = el("div", "ph-file");
	row.append(el("span", "ph-file-icon", icon(iconName, "sm")));
	const info = el("div", "ph-file-info");
	info.append(text("span", "ph-file-name", name));
	if (meta) info.append(text("span", "ph-file-meta", meta));
	if (warn) info.append(text("span", "ph-file-warn", warn));
	row.append(info);
	const rm = el("button", "icon-btn sm", icon("x", "sm"));
	rm.type = "button";
	rm.title = removeLabel;
	rm.setAttribute("aria-label", removeLabel);
	rm.onclick = onRemove;
	row.append(rm);
	return row;
}

function chatDate(ts) {
	return new Date(ts).toLocaleDateString("es", { day: "numeric", month: "short" });
}

export function renderHome() {
	const p = store.current;
	const hero = $("#project-hero");
	const home = $("#project-home");
	if (!p || !hero || !home) return;

	$(".ph-title", hero).textContent = p.name;
	const desc = $(".ph-desc", hero);
	desc.textContent = p.description;
	desc.hidden = !p.description;

	// Archivos: carpetas vinculadas y subidas.
	const files = $("#ph-files");
	files.innerHTML = "";
	for (const f of p.folders) {
		files.append(
			fileRow({
				iconName: "link",
				name: f.label,
				meta: f.path,
				warn: f.exists ? "" : "Ya no existe esta carpeta",
				removeLabel: "Quitar la carpeta del proyecto",
				onRemove: () => unlinkFolder(f),
			}),
		);
	}
	for (const u of p.uploads) {
		files.append(
			fileRow({
				iconName: u.kind === "folder" ? "folder" : "file",
				name: u.name,
				meta: u.kind === "folder" ? `${plural(u.files, "archivo", "archivos")} · ${formatSize(u.size)}` : formatSize(u.size),
				warn: u.kind === "file" && !READABLE.test(u.name) ? "No se puede leer (solo texto, PDF y Word)" : "",
				removeLabel: "Quitar del proyecto",
				onRemove: () => removeUpload(u),
			}),
		);
	}
	if (!p.folders.length && !p.uploads.length) {
		files.append(text("div", "ph-empty", `Añade documentos o carpetas: ${ui.name()} podrá leerlos y buscar en ellos desde cualquier chat del proyecto. También puedes arrastrarlos aquí.`));
	}

	// Instrucciones.
	const ins = $("#ph-instructions");
	ins.textContent = p.instructions || `Dile a ${ui.name()} cómo trabajar en este proyecto: el tono, el formato, para quién es…`;
	ins.classList.toggle("placeholder", !p.instructions);

	// Chats del proyecto.
	const sessions = ui.sessions();
	const chats = p.chats
		.map((id) => sessions.find((s) => s.id === id))
		.filter(Boolean)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const box = $("#ph-chats");
	box.innerHTML = "";
	if (!chats.length) box.append(text("div", "ph-empty", "Aún no hay chats. Escribe arriba para empezar el primero."));
	for (const s of chats) {
		const row = el("div", "ph-chat");
		row.tabIndex = 0;
		row.setAttribute("role", "button");
		const main = el("div", "ph-chat-main");
		main.append(text("span", "ph-chat-title", !s.title || s.title === "Nueva sesión" ? "Nuevo chat" : s.title));
		if (s.lastPreview) main.append(text("span", "ph-chat-preview", s.lastPreview));
		row.append(main, text("span", "ph-chat-date", chatDate(s.updatedAt)));
		const menu = el("button", "icon-btn sm", icon("dots", "sm"));
		menu.type = "button";
		menu.title = "Opciones";
		menu.setAttribute("aria-label", "Opciones del chat");
		menu.onclick = (e) => {
			e.stopPropagation();
			ui.chatMenu(menu, s.id);
		};
		row.append(menu);
		row.onclick = () => ui.openChat(s.id);
		row.onkeydown = (e) => e.key === "Enter" && e.target === row && ui.openChat(s.id);
		box.append(row);
	}
}

// ───────────────────────────── lista de proyectos ─────────────────────────────

export function renderOverview() {
	const grid = $("#pv-grid");
	if (!grid) return;
	grid.innerHTML = "";
	if (!store.list.length) {
		grid.append(text("div", "ph-empty", "Aún no tienes proyectos. Crea uno para juntar chats, documentos e instrucciones sobre un mismo tema."));
		return;
	}
	for (const p of store.list) {
		const card = el("div", "pv-card");
		card.tabIndex = 0;
		card.setAttribute("role", "button");
		const head = el("div", "pv-card-head", icon("folder"));
		head.append(text("strong", "", p.name));
		const menu = el("button", "icon-btn sm", icon("dots", "sm"));
		menu.type = "button";
		menu.title = "Opciones";
		menu.setAttribute("aria-label", "Opciones del proyecto");
		menu.onclick = (e) => {
			e.stopPropagation();
			projectMenu(menu, p.id);
		};
		head.append(menu);
		card.append(head);
		if (p.description) card.append(text("p", "", p.description));
		card.append(text("span", "pv-card-meta", `${plural(p.chats.length, "chat", "chats")} · ${chatDate(p.updatedAt)}`));
		card.onclick = () => ui.openProject(p.id);
		card.onkeydown = (e) => e.key === "Enter" && e.target === card && ui.openProject(p.id);
		grid.append(card);
	}
}

// ───────────────────────────── barra lateral ─────────────────────────────

const SIDEBAR_MAX = 6;
const SIDEBAR_CHATS = 6;

/** Sección "Proyectos" de la barra lateral. `activeProjectId`: el abierto (su página o uno de sus chats). */
export function paintSidebarProjects({ activeProjectId, activeChatId, onHome }) {
	const box = $("#project-list");
	if (!box) return;
	const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	let html = `<div class="sb-group sb-group-row"><span>Proyectos</span><button class="icon-btn sm" data-new-project title="Nuevo proyecto" aria-label="Nuevo proyecto">${icon("plus", "sm")}</button></div>`;
	if (!store.list.length) {
		html += `<div class="sb-chat sb-project-new" data-new-project role="button" tabindex="0">${icon("folderPlus", "sm")}<span class="title">Nuevo proyecto</span></div>`;
	}
	// El proyecto abierto siempre se ve, aunque no esté entre los más recientes.
	let shown = store.list.slice(0, SIDEBAR_MAX);
	const active = findProject(activeProjectId);
	if (active && !shown.includes(active)) shown = [...shown.slice(0, SIDEBAR_MAX - 1), active];
	const sessions = ui.sessions();
	for (const p of shown) {
		const isActive = p.id === activeProjectId;
		html += `<div class="sb-chat sb-project${isActive && onHome ? " active" : ""}${isActive ? " open" : ""}" data-project="${esc(p.id)}" role="listitem" tabindex="0" title="${esc(p.name)}">${icon("folder", "sm")}<span class="title">${esc(p.name)}</span><button class="icon-btn" data-pmenu aria-label="Opciones del proyecto" title="Opciones">${icon("dots", "sm")}</button></div>`;
		if (!isActive) continue;
		const chats = p.chats
			.map((id) => sessions.find((s) => s.id === id))
			.filter(Boolean)
			.sort((a, b) => b.updatedAt - a.updatedAt);
		for (const s of chats.slice(0, SIDEBAR_CHATS)) {
			const title = !s.title || s.title === "Nueva sesión" ? "Nuevo chat" : s.title;
			html += `<div class="sb-chat sb-sub${s.id === activeChatId ? " active" : ""}" data-id="${esc(s.id)}" role="listitem" tabindex="0" title="${esc(title)}"><span class="title">${esc(title)}</span><button class="icon-btn" data-menu aria-label="Opciones del chat" title="Opciones">${icon("dots", "sm")}</button></div>`;
		}
		if (chats.length > SIDEBAR_CHATS) html += `<div class="sb-chat sb-sub sb-more" data-project="${esc(p.id)}" role="button" tabindex="0"><span class="title">Ver los ${chats.length} chats</span></div>`;
	}
	if (store.list.length > shown.length) html += `<div class="sb-chat sb-more" data-overview role="button" tabindex="0"><span class="title">Ver todos los proyectos</span></div>`;
	box.innerHTML = html;
}

function bindSidebar() {
	const box = $("#project-list");
	const act = (e) => {
		const t = e.target;
		if (t.closest(".title-input")) return;
		if (t.closest("[data-new-project]")) return newProjectDialog();
		if (t.closest("[data-overview]")) return ui.openOverview();
		const pm = t.closest("[data-pmenu]");
		if (pm) return projectMenu(pm, pm.closest("[data-project]").dataset.project);
		const cm = t.closest("[data-menu]");
		if (cm) return ui.chatMenu(cm, cm.closest("[data-id]").dataset.id);
		const chat = t.closest("[data-id]");
		if (chat) return ui.openChat(chat.dataset.id);
		const proj = t.closest("[data-project]");
		if (proj) return ui.openProject(proj.dataset.project);
	};
	box.addEventListener("click", act);
	box.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && e.target.matches(".sb-chat")) act(e);
	});
}

export function initProjects(helpers) {
	ui = helpers;
	bindSidebar();
	$("#ph-add").onclick = (e) => addMenu(e.currentTarget);
	$("#ph-edit-instructions").onclick = editInstructions;
	$("#ph-instructions").onclick = editInstructions;
	$("#ph-menu").onclick = (e) => store.current && projectMenu(e.currentTarget, store.current.id);
	$("#pv-new").onclick = () => newProjectDialog();
}
