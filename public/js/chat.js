// La caja de escribir (adjuntos, arrastrar archivos) y enviar/recibir mensajes con el modelo (SSE, herramientas, aprobaciones).
import * as projects from "./projects.js";
import { icon } from "./icons.js";
import { answerApproval, api, streamChat } from "./api.js";
import { CommandPalette } from "./commands.js";
import { $, el, notifySystem, prefs, toast } from "./ui.js";
import { input, messagesBox, refs, state } from "./state.js";
import { buildAssistant, buildContent, buildUser, inProjectHome, markLast, nearBottom, paintAssistant, scrollToBottom, updateEmpty } from "./messages.js";
import { persist, setRoom } from "./rooms.js";
import { newChat, paintSidebar, panels, setRoute } from "./sidebar.js";
import { readAloud, stopReading, voice as voiceMode } from "./voiceMode.js";

// ───────────────────────────── composer ─────────────────────────────

export function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.38)}px`;
}

export function paintComposer() {
	const hasContent = input.value.trim().length > 0 || state.attachments.length > 0;
	$("#send-btn").hidden = state.busy || !hasContent;
	$("#voice-btn").hidden = state.busy || hasContent;
	$("#stop-btn").hidden = !state.busy;
}

export function setBusy(b) {
	state.busy = b;
	paintComposer();
}

export function setStatus(ok) {
	const dot = $("#status-dot");
	dot.classList.toggle("ok", ok === true);
	dot.classList.toggle("bad", ok === false);
	dot.title = ok === false ? "El último intento con el modelo falló" : ok ? "Modelo respondiendo" : "";
}

export const TEXT_EXT = /\.(txt|md|csv|json|log|xml|ya?ml|ini|js|mjs|ts|tsx|jsx|py|html?|css|java|c|cpp|h|cs|go|rs|php|rb|sh|ps1|sql|toml|env)$/i;

export async function downscaleImage(file, max = 1600, quality = 0.85) {
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

export async function addFiles(files) {
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

export function paintAttachments() {
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

export let dragDepth = 0;
export const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

// ───────────────────────────── enviar y recibir ─────────────────────────────

export async function ensureSession() {
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

export async function sendMessage(textArg, opts = {}) {
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
export function friendlyToolError(e = "") {
	if (/^El usuario rechazó/.test(e)) return "No diste permiso.";
	if (/approvalMode=deny/.test(e)) return "Bloqueado por tus ajustes de permisos.";
	if (/este canal no puede pedirla/.test(e)) return "Necesita tu permiso y aquí no se puede pedir.";
	return e.length > 220 ? `${e.slice(0, 217)}…` : e;
}

export function applyToolEvent(m, evt) {
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

export function addApprovalCard(m, evt) {
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

export async function runAssistant({ voice = false, hooks = {} } = {}) {
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
					if (evt.openVoice && !voice) setTimeout(() => voiceMode.open(), 0);
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

export function stopGeneration() {
	state.controller?.abort();
}

export function setMessageAgent(m, agent) {
	if (agent) {
		m.agent = agent.id;
		m.agentName = agent.name;
		if (!state.agents.some((a) => a.id === agent.id)) state.agents.push(agent);
	} else {
		delete m.agent;
		delete m.agentName;
	}
}

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initComposer() {
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
	input.addEventListener("paste", (e) => {
		const files = [...(e.clipboardData?.files || [])];
		if (files.length) {
			e.preventDefault();
			addFiles(files);
		}
	});
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
}
