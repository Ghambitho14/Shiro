// Ajustes → Habilidades y Ajustes → Conectores MCP.

import { api } from "./api.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** Ayudas de app.js: toast, confirmDialog, openMenu, copyText. */
let ui = null;

function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

function switchEl(checked, { disabled = false, label = "" } = {}) {
	const s = el("label", "switch", `<input type="checkbox" /><span class="track"></span>`);
	const inp = s.querySelector("input");
	inp.checked = checked;
	inp.disabled = disabled;
	if (label) inp.setAttribute("aria-label", label);
	return s;
}

function chip(text, extra = "") {
	const c = el("span", `chip ${extra}`.trim());
	c.textContent = text;
	return c;
}

function emptyBox(text) {
	const e = el("div", "ext-empty");
	e.textContent = text;
	return e;
}

/** El Shiro abierto es de antes de esta pantalla: todavía no conoce /api/skills ni /api/mcp. */
function isOldServer(err) {
	return err?.status === 404;
}

function oldServerBox() {
	const e = el(
		"div",
		"ext-empty warn",
		"<strong>Reinicia Shiro para ver esto.</strong> El Shiro que está abierto es de antes de la última actualización. Ciérralo (Ctrl+C en su consola, o cierra esa ventana) y ábrelo otra vez con <code>npm start</code>.",
	);
	e.setAttribute("role", "status");
	return e;
}

function plural(n, one, many) {
	return `${n} ${n === 1 ? one : many}`;
}

/** Ventana con un campo de texto (para rutas de carpetas). */
export function promptDialog({ title, text, placeholder = "", ok = "Aceptar" }) {
	return new Promise((resolve) => {
		const d = el("dialog");
		d.style.width = "480px";
		d.innerHTML = `<form method="dialog" style="padding:22px 24px 18px"><h2 style="margin:0 0 8px;font:600 18px/1.3 var(--font-display)"></h2><p style="margin:0 0 14px;color:var(--text-2);font-size:14px"></p><input class="input mono" required /><div class="actions-row" style="justify-content:flex-end;margin-top:16px"><button type="button" class="btn" data-v="0">Cancelar</button><button class="btn primary" type="submit"></button></div></form>`;
		d.querySelector("h2").textContent = title;
		d.querySelector("p").textContent = text;
		const inp = d.querySelector("input");
		inp.placeholder = placeholder;
		d.querySelector('[type="submit"]').textContent = ok;
		document.body.append(d);
		const done = (v) => {
			d.close();
			d.remove();
			resolve(v);
		};
		d.querySelector("form").addEventListener("submit", (e) => {
			e.preventDefault();
			done(inp.value.trim() || null);
		});
		d.querySelector('[data-v="0"]').onclick = () => done(null);
		d.addEventListener("cancel", (e) => {
			e.preventDefault();
			done(null);
		});
		d.showModal();
		inp.focus();
	});
}

/** Ventana de solo lectura con el contenido de una habilidad. */
function viewerDialog(title, subtitle, markdown) {
	const d = el("dialog", "viewer-dialog");
	d.innerHTML = `<div class="dialog-head"><h2></h2><button class="icon-btn" data-close title="Cerrar" aria-label="Cerrar">${icon("x")}</button></div><div class="viewer-body"><p class="set-desc"></p><div class="md"></div></div>`;
	d.querySelector("h2").textContent = title;
	d.querySelector(".set-desc").textContent = subtitle;
	d.querySelector(".md").innerHTML = renderMarkdown(markdown);
	d.addEventListener("click", (e) => {
		if (e.target.closest("[data-close]") || e.target === d) d.close();
	});
	d.addEventListener("close", () => d.remove());
	document.body.append(d);
	d.showModal();
}

/** Una fila desplegable: cabecera (clic para abrir) + cuerpo. */
function expandable(openSet, key, buildHead, buildBody) {
	const card = el("div", "ext-card");
	const head = el("div", "ext-row");
	head.tabIndex = 0;
	head.setAttribute("role", "button");
	head.append(el("span", "chev", icon("chevronRight", "sm")));
	buildHead(head);
	const body = el("div", "ext-body");
	const setOpen = (open) => {
		card.classList.toggle("open", open);
		head.setAttribute("aria-expanded", String(open));
		if (open) openSet.add(key);
		else openSet.delete(key);
		if (open && !body.dataset.built) {
			buildBody(body);
			body.dataset.built = "1";
		}
	};
	const toggle = (e) => {
		if (e.target.closest(".switch, button, input, a")) return;
		setOpen(!card.classList.contains("open"));
	};
	head.addEventListener("click", toggle);
	head.addEventListener("keydown", (e) => {
		if ((e.key === "Enter" || e.key === " ") && e.target === head) {
			e.preventDefault();
			setOpen(!card.classList.contains("open"));
		}
	});
	card.append(head, body);
	setOpen(openSet.has(key));
	return card;
}

// ═════════════════════════════ Habilidades ═════════════════════════════

const sk = { data: null, open: new Set(), editingId: null };

export async function loadSkills() {
	try {
		paintSkills(await api("/api/skills"));
	} catch (err) {
		if (isOldServer(err)) {
			$("#skills-own").replaceChildren(oldServerBox());
			$("#skills-apps").replaceChildren();
			return;
		}
		ui.toast(err.message, "error");
	}
}

function skillItem(s, { groupEnabled = true, editable = false } = {}) {
	const item = el("div", `ext-item${s.enabled ? "" : " off"}`);
	const text = el("div", "ext-item-text", "<strong></strong><span></span>");
	text.querySelector("strong").textContent = s.name;
	text.querySelector("span").textContent = s.description || "Sin descripción";
	text.querySelector("span").title = s.description || "";
	const view = el("button", "icon-btn sm", icon("eye", "sm"));
	view.title = "Ver instrucciones";
	view.setAttribute("aria-label", `Ver ${s.name}`);
	view.onclick = () => showSkill(s.id);
	item.append(text, view);
	if (editable) {
		const more = el("button", "icon-btn sm", icon("dots", "sm"));
		more.title = "Más opciones";
		more.setAttribute("aria-label", `Opciones de ${s.name}`);
		more.onclick = () =>
			ui.openMenu(
				more,
				[
					{ label: "Editar", icon: "pencil", onClick: () => editSkill(s.id) },
					{ label: "Eliminar", icon: "trash", danger: true, onClick: () => deleteSkill(s) },
				],
				"right",
			);
		item.append(more);
	}
	const sw = switchEl(s.enabled && groupEnabled, { disabled: !groupEnabled, label: `Usar ${s.name}` });
	sw.querySelector("input").onchange = async (e) => {
		try {
			paintSkills(await api("/api/skills/toggle", { method: "PUT", json: { id: s.id, enabled: e.target.checked } }));
		} catch (err) {
			e.target.checked = !e.target.checked;
			ui.toast(err.message, "error");
		}
	};
	item.append(sw);
	return item;
}

function skillList(body, skills, groupEnabled, emptyText, appLabel = "") {
	if (!skills.length) {
		body.append(emptyBox(emptyText));
		return;
	}
	if (!groupEnabled) body.append(el("p", "ext-hint", "Activa el interruptor de arriba para que Shiro pueda usarlas."));
	for (const s of skills.filter((x) => !x.builtIn)) body.append(skillItem(s, { groupEnabled }));
	const builtIn = skills.filter((x) => x.builtIn);
	if (builtIn.length) {
		const hint = el("p", "ext-hint");
		hint.textContent = `Incluidas con ${appLabel || "la aplicación"}: empiezan apagadas porque suelen necesitar herramientas que solo tiene esa aplicación. Enciende las que quieras probar.`;
		body.append(hint);
		for (const s of builtIn) body.append(skillItem(s, { groupEnabled }));
	}
}

/** "13 habilidades", o "5 de 13 en uso" si hay apagadas. */
function skillCountChip(group) {
	if (!group.exists) return chip("No instalado", "muted");
	const total = group.skills.length;
	if (!total) return chip("Sin habilidades", "muted");
	const on = group.enabled ? group.skills.filter((s) => s.enabled).length : 0;
	return chip(on === total ? plural(total, "habilidad", "habilidades") : `${on} de ${total} en uso`, on ? "" : "muted");
}

function paintSkills(d) {
	sk.data = d;
	const own = $("#skills-own");
	own.innerHTML = "";
	if (!d.own.skills.length) own.append(emptyBox("No hay habilidades de Shiro instaladas. Crea una con «Agregar habilidad»."));
	for (const s of d.own.skills) own.append(skillItem(s, { editable: true }));

	const apps = $("#skills-apps");
	apps.innerHTML = "";
	// Primero las aplicaciones en las que se encontraron habilidades.
	const found = [...d.apps].sort((a, b) => Number(b.skills.length > 0) - Number(a.skills.length > 0));
	for (const a of found) {
		apps.append(
			expandable(
				sk.open,
				a.source,
				(head) => {
					const name = el("strong", "ext-name");
					name.textContent = a.label;
					head.append(name);
					head.append(skillCountChip(a));
					const path = chip(a.dir, "mono path");
					path.title = a.dir;
					head.append(path, el("span", "spacer"));
					const sw = switchEl(a.enabled, { disabled: !a.exists, label: `Usar las habilidades de ${a.label}` });
					sw.querySelector("input").onchange = async (e) => {
						try {
							paintSkills(await api("/api/skills/app", { method: "PUT", json: { source: a.source, enabled: e.target.checked } }));
							ui.toast(e.target.checked ? `Usando las habilidades de ${a.label}` : `Habilidades de ${a.label} desactivadas`);
						} catch (err) {
							e.target.checked = !e.target.checked;
							ui.toast(err.message, "error");
						}
					};
					head.append(sw);
				},
				(body) => skillList(body, a.skills, a.enabled, a.exists ? "Esta carpeta no tiene habilidades." : `No existe la carpeta ${a.dir}.`, a.label),
			),
		);
	}

	$("#skills-folders-group").hidden = !d.folders.length;
	const folders = $("#skills-folders");
	folders.innerHTML = "";
	for (const f of d.folders) {
		folders.append(
			expandable(
				sk.open,
				f.source,
				(head) => {
					const name = el("strong", "ext-name mono path");
					name.textContent = f.path;
					name.title = f.path;
					head.append(name, f.exists ? chip(plural(f.skills.length, "habilidad", "habilidades")) : chip("No existe", "muted"), el("span", "spacer"));
					const rm = el("button", "icon-btn sm", icon("trash", "sm"));
					rm.title = "Quitar esta carpeta (no borra nada del disco)";
					rm.setAttribute("aria-label", "Quitar carpeta");
					rm.onclick = async () => {
						try {
							paintSkills(await api("/api/skills/folders", { method: "DELETE", json: { path: f.path } }));
						} catch (err) {
							ui.toast(err.message, "error");
						}
					};
					head.append(rm);
				},
				(body) => skillList(body, f.skills, true, "Esta carpeta no tiene habilidades."),
			),
		);
	}
}

async function showSkill(id) {
	try {
		const d = await api("/api/skills/detail?id=" + encodeURIComponent(id));
		viewerDialog(d.name, `${d.description}  ·  ${d.dir}`, d.body);
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function openSkillEditor(detail = null) {
	sk.editingId = detail?.id ?? null;
	$("#skill-editor-title").textContent = detail ? `Editar "${detail.name}"` : "Nueva habilidad";
	$("#skill-name").value = detail?.name ?? "";
	$("#skill-desc").value = detail?.description ?? "";
	$("#skill-body").value = detail?.body ?? "";
	const box = $("#skill-editor");
	box.hidden = false;
	box.scrollIntoView({ behavior: "smooth", block: "start" });
	$("#skill-name").focus();
}

async function editSkill(id) {
	try {
		openSkillEditor(await api("/api/skills/detail?id=" + encodeURIComponent(id)));
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function deleteSkill(s) {
	const ok = await ui.confirmDialog({
		title: `¿Eliminar "${s.name}"?`,
		text: "Se borra su carpeta con todos sus archivos. No se puede deshacer.",
		ok: "Eliminar",
		danger: true,
	});
	if (!ok) return;
	try {
		paintSkills(await api("/api/skills", { method: "DELETE", json: { id: s.id } }));
		ui.toast("Habilidad eliminada");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function saveSkill() {
	try {
		const d = await api("/api/skills", {
			method: "POST",
			json: {
				name: $("#skill-name").value.trim(),
				description: $("#skill-desc").value.trim(),
				instructions: $("#skill-body").value,
				originalId: sk.editingId || undefined,
			},
		});
		$("#skill-editor").hidden = true;
		paintSkills(d);
		ui.toast("Habilidad guardada");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function importSkillFile(file) {
	if (!file) return;
	try {
		if (file.size > 256 * 1024) throw new Error("El archivo es demasiado grande (máx. 256 KB).");
		const d = await api("/api/skills/import", { method: "POST", json: { filename: file.name, content: await file.text() } });
		paintSkills(d);
		ui.toast("Habilidad importada");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function openSkillsFolder() {
	try {
		await api("/api/skills/open-folder", { method: "POST" });
		ui.toast("Copia dentro carpetas con un SKILL.md y pulsa «Actualizar la lista».", "info", 6000);
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function addSkillFolder() {
	const path = await promptDialog({
		title: "Añadir carpeta de habilidades",
		text: "Ruta de una carpeta que tenga habilidades dentro (subcarpetas con un archivo SKILL.md).",
		placeholder: "C:\\Users\\tú\\mis-habilidades",
		ok: "Añadir",
	});
	if (!path) return;
	try {
		paintSkills(await api("/api/skills/folders", { method: "POST", json: { path } }));
		ui.toast("Carpeta añadida");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function bindSkills() {
	$("#skill-add").onclick = (e) =>
		ui.openMenu(
			e.currentTarget,
			[
				{ label: "Crear habilidad", icon: "pencil", onClick: () => openSkillEditor() },
				{ label: "Importar un archivo SKILL.md", icon: "upload", onClick: () => $("#skill-file").click() },
				"sep",
				{ label: "Abrir la carpeta de habilidades", icon: "folder", onClick: openSkillsFolder },
				{ label: "Añadir otra carpeta…", icon: "plus", onClick: addSkillFolder },
				{ label: "Actualizar la lista", icon: "refresh", onClick: loadSkills },
			],
			"right",
		);
	$("#skill-file").onchange = (e) => {
		importSkillFile(e.target.files?.[0]);
		e.target.value = "";
	};
	$("#skill-save").onclick = saveSkill;
	$("#skill-cancel").onclick = () => ($("#skill-editor").hidden = true);
}

// ═════════════════════════════ MCP ═════════════════════════════

const mc = { data: null, open: new Set(), logs: new Set(), editing: null, kind: "stdio", poll: 0 };

const STATE_LABEL = { ready: "Conectado", connecting: "Conectando…", error: "Error", off: "Apagado" };

export async function loadMcp() {
	try {
		paintMcp(await api("/api/mcp"));
	} catch (err) {
		if (isOldServer(err)) {
			$("#mcp-list").replaceChildren(oldServerBox());
			return;
		}
		ui.toast(err.message, "error");
	}
}

function mcpVisible() {
	return $("#settings-dialog").open && $('section[data-panel="mcp"]').classList.contains("active");
}

function schedulePoll(d) {
	clearTimeout(mc.poll);
	if (d.servers.some((s) => s.state === "connecting")) {
		mc.poll = setTimeout(() => mcpVisible() && loadMcp(), 1500);
	}
}

async function patchServer(name, patch, okMessage = "") {
	try {
		paintMcp(await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "PATCH", json: patch }));
		if (okMessage) ui.toast(okMessage);
		return true;
	} catch (err) {
		ui.toast(err.message, "error");
		return false;
	}
}

function toolItem(server, t) {
	const item = el("div", `ext-item${t.enabled ? "" : " off"}`);
	const text = el("div", "ext-item-text", "<strong class=\"mono\"></strong><span></span>");
	const desc = text.querySelector(":scope > span");
	text.querySelector("strong").textContent = t.name;
	if (t.readOnly) text.querySelector("strong").append(chip("solo lectura", "tiny"));
	desc.textContent = t.description || "Sin descripción";
	desc.title = t.description || "";
	const ask = el("label", "check", `<input type="checkbox" /><span>Sin preguntar</span>`);
	const askInput = ask.querySelector("input");
	askInput.checked = t.alwaysAllow;
	ask.title = "Si lo marcas, Shiro usará esta herramienta sin pedirte permiso";
	askInput.onchange = async () => {
		if (askInput.checked && !t.readOnly) {
			const ok = await ui.confirmDialog({
				title: `¿Usar "${t.name}" sin preguntar?`,
				text: `Shiro podrá usar esta herramienta de ${server.name} sin pedirte permiso cada vez. Hazlo solo si sabes lo que hace.`,
				ok: "Sí, sin preguntar",
			});
			if (!ok) {
				askInput.checked = false;
				return;
			}
		}
		const allow = server.tools.filter((x) => (x.name === t.name ? askInput.checked : x.alwaysAllow)).map((x) => x.name);
		if (!(await patchServer(server.name, { alwaysAllow: allow }))) askInput.checked = !askInput.checked;
	};
	const sw = switchEl(t.enabled, { label: `Ofrecer ${t.name} al modelo` });
	sw.querySelector("input").onchange = async (e) => {
		const off = server.tools.filter((x) => (x.name === t.name ? !e.target.checked : !x.enabled)).map((x) => x.name);
		if (!(await patchServer(server.name, { disabledTools: off }))) e.target.checked = !e.target.checked;
	};
	item.append(text, ask, sw);
	return item;
}

function serverBody(body, s) {
	if (s.error) {
		const n = el("div", "notice bad", `${icon("alert", "sm")}<span></span>`);
		n.querySelector("span").textContent = s.error;
		body.append(n);
	}
	if (s.state === "connecting") body.append(el("p", "ext-hint", "Arrancando… La primera vez puede tardar un poco si tiene que descargarse."));
	if (s.state === "off") body.append(el("p", "ext-hint", "Apagado: enciéndelo con el interruptor para que Shiro pueda usarlo."));
	if (s.tools.length) {
		const list = el("div", "ext-tools");
		const title = el("p", "ext-hint", "");
		title.textContent = `Herramientas (${s.tools.length}). Todas piden permiso antes de usarse salvo las marcadas «Sin preguntar».`;
		list.append(title);
		for (const t of s.tools) list.append(toolItem(s, t));
		body.append(list);
	} else if (s.state === "ready") {
		body.append(el("p", "ext-hint", "Este servidor no ofrece herramientas."));
	}
	if (s.serverVersion) {
		const v = el("p", "ext-hint");
		v.textContent = `Servidor: ${s.serverVersion}`;
		body.append(v);
	}

	const actions = el("div", "actions-row");
	const btn = (label, iconName, onClick, cls = "btn sm") => {
		const b = el("button", cls, `${icon(iconName, "sm")}<span></span>`);
		b.querySelector("span").textContent = label;
		b.onclick = onClick;
		actions.append(b);
		return b;
	};
	if (!s.disabled) {
		btn("Reiniciar", "refresh", async () => {
			try {
				paintMcp(await api(`/api/mcp/servers/${encodeURIComponent(s.name)}/restart`, { method: "POST" }));
			} catch (err) {
				ui.toast(err.message, "error");
			}
		});
	}
	btn("Editar", "pencil", () => openMcpEditor(s));
	if (s.kind === "stdio") {
		btn(mc.logs.has(s.name) ? "Ocultar registro" : "Ver registro", "terminal", () => {
			if (mc.logs.has(s.name)) mc.logs.delete(s.name);
			else mc.logs.add(s.name);
			paintMcp(mc.data);
		});
	}
	btn("Eliminar", "trash", () => deleteServer(s), "btn sm danger");
	body.append(actions);

	if (mc.logs.has(s.name)) {
		const pre = el("pre", "mcp-log");
		pre.textContent = s.log.length ? s.log.join("\n") : "(sin mensajes)";
		body.append(pre);
	}
}

function paintMcp(d) {
	mc.data = d;
	const err = $("#mcp-config-error");
	err.innerHTML = "";
	if (d.configError) {
		const n = el("div", "notice bad", `${icon("alert", "sm")}<span></span>`);
		n.querySelector("span").textContent = `${d.configError}. Corrígelo con «Agregar servidor» → «Editar mcp.json».`;
		err.append(n);
	}

	const list = $("#mcp-list");
	list.innerHTML = "";
	if (!d.servers.length) list.append(emptyBox("Todavía no hay servidores. Usa «Agregar servidor»: hay ejemplos listos para probar."));
	for (const s of d.servers) {
		list.append(
			expandable(
				mc.open,
				s.name,
				(head) => {
					const dot = el("span", `state-dot ${s.state}`);
					dot.title = STATE_LABEL[s.state] || s.state;
					const name = el("strong", "ext-name");
					name.textContent = s.name;
					head.append(dot, name);
					const enabledTools = s.tools.filter((t) => t.enabled).length;
					head.append(
						s.state === "ready"
							? chip(plural(enabledTools, "herramienta", "herramientas"))
							: chip(STATE_LABEL[s.state] || s.state, s.state === "error" ? "bad" : "muted"),
					);
					const target = chip(s.target, "mono path");
					target.title = s.target;
					head.append(target, el("span", "spacer"));
					const sw = switchEl(!s.disabled, { label: `Encender ${s.name}` });
					sw.querySelector("input").onchange = (e) =>
						patchServer(s.name, { disabled: !e.target.checked }, e.target.checked ? `Conectando con ${s.name}…` : `${s.name} apagado`);
					head.append(sw);
				},
				(body) => serverBody(body, s),
			),
		);
	}

	$("#mcp-self-snippet").textContent = JSON.stringify({ mcpServers: { shiro: d.shiroMcp } }, null, 2);
	schedulePoll(d);
}

async function deleteServer(s) {
	const ok = await ui.confirmDialog({
		title: `¿Eliminar "${s.name}"?`,
		text: "Shiro dejará de usar este servidor. Se quita de la lista (no desinstala nada de tu PC).",
		ok: "Eliminar",
		danger: true,
	});
	if (!ok) return;
	try {
		mc.open.delete(s.name);
		paintMcp(await api(`/api/mcp/servers/${encodeURIComponent(s.name)}`, { method: "DELETE" }));
		ui.toast("Servidor eliminado");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function quoteArg(a) {
	return a === "" || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

function setKind(kind) {
	mc.kind = kind;
	for (const b of document.querySelectorAll("#mcp-kind button")) b.classList.toggle("active", b.dataset.value === kind);
	$("#mcp-stdio-fields").hidden = kind !== "stdio";
	$("#mcp-http-fields").hidden = kind !== "http";
}

/** server: el de la lista (editar) · preset: { name, command } o { name, url } (ejemplos) · nada: nuevo. */
function openMcpEditor(server = null, preset = null) {
	const cfg = server?.config ?? {};
	mc.editing = server ? server.name : null;
	$("#mcp-editor-title").textContent = server ? `Editar "${server.name}"` : preset ? `Nuevo servidor: ${preset.label}` : "Nuevo servidor";
	$("#mcp-name").value = server?.name ?? preset?.name ?? "";
	setKind(cfg.url || preset?.url ? "http" : "stdio");
	$("#mcp-command").value = cfg.command ? [cfg.command, ...(cfg.args || [])].map(quoteArg).join(" ") : preset?.command ?? "";
	$("#mcp-env").value = Object.entries(cfg.env || {})
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	$("#mcp-url").value = cfg.url ?? preset?.url ?? "";
	$("#mcp-headers").value = Object.entries(cfg.headers || {})
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	$("#mcp-raw").hidden = true;
	const box = $("#mcp-editor");
	box.hidden = false;
	box.scrollIntoView({ behavior: "smooth", block: "start" });
	(server || preset ? $(mc.kind === "http" ? "#mcp-url" : "#mcp-command") : $("#mcp-name")).focus();
}

function parseLines(text, sep) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const i = line.indexOf(sep);
		if (i <= 0) throw new Error(`Esta línea no tiene el formato ${sep === "=" ? "NOMBRE=valor" : "Nombre: valor"}: ${line}`);
		out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return out;
}

async function saveServer() {
	const name = $("#mcp-name").value.trim();
	try {
		if (!name) throw new Error("Ponle un nombre al servidor.");
		const config =
			mc.kind === "http"
				? { url: $("#mcp-url").value.trim(), headers: parseLines($("#mcp-headers").value, ":") }
				: { commandLine: $("#mcp-command").value.trim(), env: parseLines($("#mcp-env").value, "=") };
		const d = await api(`/api/mcp/servers/${encodeURIComponent(name)}`, {
			method: "PUT",
			json: { config, originalName: mc.editing || undefined },
		});
		$("#mcp-editor").hidden = true;
		mc.open.add(name);
		paintMcp(d);
		ui.toast(`Guardado. Conectando con ${name}…`);
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function openRawEditor() {
	try {
		const d = await api("/api/mcp/raw");
		$("#mcp-raw-text").value = d.text;
		$("#mcp-raw-file").textContent = d.file;
		$("#mcp-raw-error").innerHTML = "";
		$("#mcp-editor").hidden = true;
		const box = $("#mcp-raw");
		box.hidden = false;
		box.scrollIntoView({ behavior: "smooth", block: "start" });
		$("#mcp-raw-text").focus();
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

async function saveRaw() {
	const errBox = $("#mcp-raw-error");
	errBox.innerHTML = "";
	try {
		const d = await api("/api/mcp/raw", { method: "PUT", json: { text: $("#mcp-raw-text").value } });
		$("#mcp-raw").hidden = true;
		paintMcp(d);
		ui.toast("mcp.json guardado");
	} catch (err) {
		const n = el("div", "notice bad", `${icon("alert", "sm")}<span></span>`);
		n.querySelector("span").textContent = err.message;
		errBox.append(n);
	}
}

async function importFrom(source) {
	try {
		const d = await api("/api/mcp/import", { method: "POST", json: { source: source.id } });
		paintMcp(d);
		ui.toast(d.added ? `Importados ${plural(d.added, "servidor", "servidores")} de ${source.label}` : "No había servidores nuevos que importar");
	} catch (err) {
		ui.toast(err.message, "error");
	}
}

function examples() {
	const docs = `${(mc.data?.home || "C:\\Users\\tú").replace(/[\\/]+$/, "")}${mc.data?.home?.includes("\\") ? "\\" : "/"}Documents`;
	return [
		{ label: "Navegador web (Playwright)", name: "navegador", command: "npx -y @playwright/mcp@latest" },
		{ label: "Archivos de una carpeta", name: "archivos", command: `npx -y @modelcontextprotocol/server-filesystem ${quoteArg(docs)}` },
		{ label: "Documentación de programación (Context7)", name: "context7", url: "https://mcp.context7.com/mcp" },
	];
}

function bindMcp() {
	$("#mcp-add").onclick = (e) => {
		const items = [{ label: "Nuevo servidor", icon: "plus", onClick: () => openMcpEditor() }, "sep"];
		for (const ex of examples()) items.push({ label: `Ejemplo: ${ex.label}`, icon: "sparkles", onClick: () => openMcpEditor(null, ex) });
		const imports = (mc.data?.imports || []).filter((x) => x.fresh > 0);
		if (imports.length) {
			items.push("sep");
			for (const x of imports) items.push({ label: `Importar de ${x.label} (${x.fresh})`, icon: "download", onClick: () => importFrom(x) });
		}
		items.push("sep", { label: "Editar mcp.json", icon: "braces", onClick: openRawEditor });
		ui.openMenu(e.currentTarget, items, "right");
	};
	$("#mcp-kind").onclick = (e) => {
		const b = e.target.closest("[data-value]");
		if (b) setKind(b.dataset.value);
	};
	$("#mcp-save").onclick = saveServer;
	$("#mcp-cancel").onclick = () => ($("#mcp-editor").hidden = true);
	$("#mcp-raw-save").onclick = saveRaw;
	$("#mcp-raw-cancel").onclick = () => ($("#mcp-raw").hidden = true);
	$("#mcp-raw-text").addEventListener("keydown", (e) => {
		// Tab escribe una sangría en vez de saltar al siguiente campo.
		if (e.key !== "Tab" || e.shiftKey) return;
		e.preventDefault();
		const t = e.target;
		const { selectionStart: a, selectionEnd: b } = t;
		t.setRangeText("  ", a, b, "end");
	});
	$("#mcp-self-copy").onclick = () => ui.copyText($("#mcp-self-snippet").textContent, null).then(() => ui.toast("Copiado"));
}

// ═════════════════════════════ inicio ═════════════════════════════

export function initExtensions(helpers) {
	ui = helpers;
	bindSkills();
	bindMcp();
}

/** Se llama al mostrar una pestaña de Ajustes. */
export function onSettingsTab(tab) {
	if (tab === "skills") loadSkills();
	if (tab === "mcp") loadMcp();
	else clearTimeout(mc.poll);
}

