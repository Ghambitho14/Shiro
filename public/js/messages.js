// Contenido de los mensajes (archivos adjuntos, texto) y cómo se pintan en el hilo.
import * as projects from "./projects.js";
import { icon } from "./icons.js";
import { protectedImageUrl } from "./api.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { agentAvatar, agentColor } from "./agents.js";
import { $, $$, copyText, el, lightbox } from "./ui.js";
import { input, messagesBox, refs, state, thread } from "./state.js";
import { regenerate, startEdit } from "./rooms.js";
import { openProject } from "./sidebar.js";
import { readAloud } from "./voiceMode.js";

// ───────────────────────────── contenido de mensajes ─────────────────────────────

export const FILE_RE = /\n*<<<archivo: ([^>\n]+)>>>\n[\s\S]*?\n<<<fin del archivo>>>/g;

/** Separa lo que se muestra (texto, imágenes, nombres de archivos) del contenido enviado al modelo. */
export function contentParts(content) {
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

export function fileBlocks(raw) {
	return [...String(raw).matchAll(FILE_RE)].map((m) => m[0]).join("");
}

export function buildContent(text, attachments) {
	let full = text;
	for (const a of attachments.filter((x) => x.kind === "file")) {
		full += `\n\n<<<archivo: ${a.name}>>>\n${a.text}\n<<<fin del archivo>>>`;
	}
	const images = attachments.filter((a) => a.kind === "image");
	if (!images.length) return full.trim();
	return [{ type: "text", text: full.trim() || "¿Qué hay en esta imagen?" }, ...images.map((a) => ({ type: "image_url", image_url: { url: a.dataUrl } }))];
}

export function replaceText(content, newText) {
	if (typeof content === "string") return (newText + fileBlocks(content)).trim();
	const { raw, images } = contentParts(content);
	return [{ type: "text", text: (newText + fileBlocks(raw)).trim() || "¿Qué hay en esta imagen?" }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))];
}

export function fromServer(m) {
	const out = { role: m.role, content: m.content, ts: m.ts };
	if (m.agent) Object.assign(out, { agent: m.agent, agentName: m.agentName });
	if (Array.isArray(m.tools)) out.tools = m.tools.map((t, i) => ({ id: `h${i}`, name: t.name, label: t.label, status: t.ok === false ? "fail" : "ok", image: t.image }));
	return out;
}

export function serialize(m) {
	const o = { role: m.role, content: m.content };
	if (m.ts) o.ts = m.ts;
	if (m.agent) Object.assign(o, { agent: m.agent, agentName: m.agentName });
	if (m.tools?.length) {
		o.tools = m.tools.map((t) => ({ name: t.name, label: t.label, ok: t.status !== "fail", ...(t.image ? { image: t.image } : {}) }));
	}
	return o;
}

// ───────────────────────────── pintar mensajes ─────────────────────────────

export function actionButton(name, title, onClick) {
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

export function buildUser(m) {
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

export function buildAssistant(m) {
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

export function paintSteps(m) {
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
export function agentOf(m) {
	if (!m?.agent) return null;
	return state.agents.find((a) => a.id === m.agent) || { id: m.agent, name: m.agentName || m.agent };
}

/** En una sala, cada respuesta lleva el nombre y el color de quien habló. */
export function paintAuthor(m) {
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

export function paintAssistant(m) {
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

export function renderThread() {
	messagesBox.innerHTML = "";
	for (const m of state.messages) messagesBox.append(m.role === "user" ? buildUser(m) : buildAssistant(m));
	markLast();
	updateEmpty();
}

export function markLast() {
	$$(".msg.assistant.last", messagesBox).forEach((e) => e.classList.remove("last"));
	const last = [...state.messages].reverse().find((m) => m.role === "assistant");
	if (last) refs.get(last)?.root.classList.add("last");
}

export function updateEmpty() {
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

export const inProjectHome = () => Boolean(state.projectHome && !state.activeId && state.messages.length === 0);

/** En un chat de un proyecto, la barra superior muestra el proyecto (clic: volver a su página). */
export function paintCrumb() {
	const p = state.activeId ? projects.projectOfChat(state.activeId) : null;
	const crumb = $("#project-crumb");
	crumb.hidden = !p;
	if (!p) return;
	$(".crumb-name", crumb).textContent = p.name;
	crumb.onclick = () => openProject(p.id);
}

export function nearBottom() {
	return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 140;
}

export function scrollToBottom(smooth = false) {
	thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initMessages() {
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
}
