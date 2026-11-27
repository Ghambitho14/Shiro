// La caja de escribir (adjuntos, arrastrar archivos) y enviar/recibir mensajes con el modelo (SSE, herramientas, aprobaciones).
import * as projects from "./projects.js";
import { icon } from "./icons.js";
import { answerApproval, answerQuestions, api, streamChat } from "./api.js";
import { CommandPalette } from "./commands.js";
import { $, $$, el, notifySystem, openMenu, prefs, toast } from "./ui.js";
import { input, messagesBox, refs, state } from "./state.js";
import { buildAssistant, buildContent, buildUser, followingBottom, fromServer, inProjectHome, markLast, paintAssistant, renderThread, scrollToBottom, updateEmpty } from "./messages.js";
import { persist, setRoom } from "./rooms.js";
import { newChat, paintSidebar, panels, rememberChat, setRoute } from "./sidebar.js";
import { readAloud, stopReading, voice as voiceMode } from "./voiceMode.js";
import { refreshContextMeter } from "./contextMeter.js";
import { workProjectForNewChat } from "./workFolder.js";
import { isSensitiveFile } from "./sensitiveFiles.js";

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
	// El modo y los permisos forman parte de la petición: no se cambian a mitad de una respuesta.
	$$("#mode-seg .mode-opt").forEach((b) => (b.disabled = state.busy));
	$("#perm-btn").disabled = state.busy;
	$("#reason-btn").disabled = state.busy;
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

const FOLDER_MAX_FILES = 200;
const FOLDER_MAX_CHARS = 200_000;
const FOLDER_MAX_FILE_BYTES = 100_000;
const FOLDER_SKIP_DIRS = /(^|\/)(node_modules|\.git|\.next|\.venv|venv|__pycache__|dist|build|target|vendor)\//i;
/** Claves y credenciales: nunca salen de la carpeta hacia el modelo. */
const FOLDER_TEXT_NAME = /(^|\/)(dockerfile|makefile|readme|license|\.gitignore|\.dockerignore)$/i;

/**
 * Añade una carpeta como un solo adjunto: se lee aquí, en el navegador, con cada archivo bajo su ruta.
 * Solo texto: sin carpetas generadas, binarios ni archivos con claves, y dentro de un tope.
 */
export async function addFolder(files) {
	if (!files.length) return;
	if (state.attachments.length >= 6) {
		toast("Máximo 6 archivos por mensaje.", "error");
		return;
	}
	const name = (files[0].webkitRelativePath || files[0].name).split("/")[0];
	const parts = [];
	const skipped = { secret: 0, other: 0, limit: 0 };
	let chars = 0;
	for (const f of files) {
		const path = f.webkitRelativePath || f.name;
		if (FOLDER_SKIP_DIRS.test(path)) continue;
		if (isSensitiveFile(path)) {
			skipped.secret++;
			continue;
		}
		if (!(f.type.startsWith("text/") || TEXT_EXT.test(path) || FOLDER_TEXT_NAME.test(path))) {
			skipped.other++;
			continue;
		}
		if (f.size > FOLDER_MAX_FILE_BYTES || parts.length >= FOLDER_MAX_FILES || chars + f.size > FOLDER_MAX_CHARS) {
			skipped.limit++;
			continue;
		}
		try {
			const text = await f.text();
			parts.push(`--- ${path} ---\n${text}`);
			chars += text.length;
		} catch {
			skipped.other++;
		}
	}
	if (!parts.length) {
		toast(`No encontré archivos de texto que pueda leer en ${name}.`, "error");
		return;
	}
	state.attachments.push({ kind: "file", name: `${name}/ (${parts.length} ${parts.length === 1 ? "archivo" : "archivos"})`, text: parts.join("\n\n") });
	paintAttachments();
	paintComposer();
	input.focus();
	const notes = [];
	if (skipped.secret) notes.push(`${skipped.secret} con posibles claves`);
	if (skipped.limit) notes.push(`${skipped.limit} por tamaño`);
	if (skipped.other) notes.push(`${skipped.other} que no son texto`);
	toast(`Añadí ${parts.length} de ${name}${notes.length ? `; omití ${notes.join(", ")}` : ""}.`);
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
	// Página de un proyecto, o la carpeta elegida en el modo Code.
	const projectId = state.projectHome || workProjectForNewChat();
	const d = await api("/api/chat-sessions", { method: "POST", json: { mode: state.mode, ...(projectId ? { projectId } : {}) } });
	if (projectId) projects.noteChatInProject(projectId, d.session.id);
	state.projectHome = null;
	state.activeId = d.session.id;
	state.sessions.unshift({ ...d.session, mode: d.session.mode || state.mode });
	rememberChat(d.session.id);
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
	const m = { role: "user", content: buildContent(text, attachments), ts: Date.now(), mode: state.mode };
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
	if (evt.undo) t.undo = evt.undo;
	if (evt.drawing) t.drawing = evt.drawing;
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

/**
 * Tarjeta de ask_user: cada pregunta con sus opciones (una o varias) y «Otra» para escribir.
 * Al enviar, el paso de la respuesta guarda qué se preguntó y qué se eligió (se ve al recargar el chat).
 */
export function addQuestionCard(m, evt) {
	const r = refs.get(m);
	const who = m.agentName || state.name;
	const card = el("div", "question-card");
	const head = el("div", "question-head", `${icon("help", "sm")}<span></span>`);
	$("span", head).textContent = `${who} te pregunta`;
	card.append(head);
	const picks = evt.questions.map(() => new Set());
	const others = [];
	const send = el("button", "btn primary sm", "Enviar");
	const skip = el("button", "btn ghost sm", "Saltar");
	const answerOf = (i) => [...picks[i], others[i].value.trim()].filter(Boolean).join(", ");
	const refresh = () => (send.disabled = evt.questions.some((_, i) => !answerOf(i)));
	evt.questions.forEach((q, i) => {
		const box = el("div", "question-item");
		const text = el("div", "question-text");
		text.textContent = q.question + (q.multiple ? " (puedes elegir varias)" : "");
		const opts = el("div", "question-options");
		for (const o of q.options || []) {
			const b = el("button", "question-opt");
			b.type = "button";
			b.textContent = o;
			b.onclick = () => {
				if (picks[i].has(o)) picks[i].delete(o);
				else {
					if (!q.multiple) picks[i].clear();
					picks[i].add(o);
				}
				for (const x of opts.children) x.classList.toggle("on", picks[i].has(x.textContent));
				refresh();
			};
			opts.append(b);
		}
		const other = el("input", "question-other");
		other.placeholder = q.options?.length ? "Otra (escríbela)" : "Tu respuesta";
		other.maxLength = 500;
		other.oninput = refresh;
		other.onkeydown = (e) => {
			if (e.key === "Enter" && !send.disabled) send.click();
		};
		others.push(other);
		box.append(text, opts, other);
		card.append(box);
	});
	const actions = el("div", "question-actions");
	actions.append(send, skip);
	card.append(actions);
	refresh();

	const entry = { done: false };
	const close = (text) => {
		entry.done = true;
		card.className = "question-card done";
		card.textContent = text;
		paintAssistant(m);
	};
	/** El paso de ask_user guarda las respuestas en su texto. */
	const noteInStep = (answers) => {
		const step = [...(m.tools || [])].reverse().find((t) => t.name === "ask_user");
		if (!step) return;
		step.label = answers
			? "Te preguntó: " + evt.questions.map((q, i) => `${q.question} → ${answers[i]}`).join(" · ")
			: "Te preguntó (sin respuesta): " + evt.questions.map((q) => q.question).join(" · ");
	};
	const answer = async (answers) => {
		if (entry.done) return;
		noteInStep(answers);
		close(answers ? evt.questions.map((q, i) => `✓ ${q.question} → ${answers[i]}`).join("\n") : "Preguntas saltadas.");
		try {
			await answerQuestions(evt.id, answers);
		} catch (err) {
			toast(err.message, "error");
		}
	};
	send.onclick = () => answer(evt.questions.map((_, i) => answerOf(i)));
	skip.onclick = () => answer(null);
	entry.id = evt.id;
	entry.expire = () => {
		if (entry.done) return;
		noteInStep(null);
		close("Las preguntas ya no esperan respuesta.");
	};
	entry.cancel = entry.expire;
	r.approvals.append(card);
	r.cards.push(entry);
	setTimeout(() => (others[0] && !evt.questions[0].options?.length ? others[0].focus() : null), 0);
	notifySystem(`${who} te pregunta`, evt.questions[0]?.question || "");
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
	const controller = new AbortController();
	state.controller = controller;
	setBusy(true);
	// Tu mensaje se guarda antes de pedir la respuesta: si se corta la conexión (saliste de la app o de
	// este chat), el servidor termina la respuesta y la añade él mismo a este chat.
	await persist(sessionId, list);
	const m = { role: "assistant", content: "", tools: [], ts: Date.now(), streaming: true };
	list.push(m);
	if (list === state.messages) {
		messagesBox.append(buildAssistant(m));
		markLast();
		scrollToBottom();
	}
	let raf = 0;
	const repaint = () => {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			const stick = followingBottom();
			paintAssistant(m);
			if (stick) scrollToBottom();
			else $("#scroll-bottom").classList.toggle("show", true);
		});
	};
	// También al regenerar: el último mensaje guarda el modo con el que se respondió.
	const lastUser = [...list].reverse().find((x) => x.role === "user");
	if (lastUser) lastUser.mode = state.mode;
	// En una sala el servidor necesita saber qué agente dijo cada respuesta.
	const payload = list
		.filter((x) => x !== m && !x.error)
		.map((x) => ({
			role: x.role,
			content: x.content,
			...(x.agent ? { agent: x.agent, agentName: x.agentName } : {}),
			...(x.mode ? { mode: x.mode } : {}),
			// Qué herramientas usó en cada respuesta y su lista de tareas: así sabe qué miró en la anterior.
			...(x.tools?.length ? { tools: x.tools.map((t) => ({ name: t.name, label: t.label, ok: t.status !== "fail" })) } : {}),
			...(x.todo?.length ? { todo: x.todo } : {}),
		}));

	// La cajita de voz (miniVoice.js) no pregunta: lo que dices en voz alta ya es la orden. Enviar correos y
	// crear eventos siguen preguntando (`alwaysAsksUser`) y «bloquear» de Ajustes sigue mandando.
	const permissions = state.mini ? "bypass" : state.permissions;
	try {
		await streamChat(
			{ messages: payload, sessionId, voice, mode: state.mode, permissions, reasoning: state.moreReasoning ? "more" : undefined },
			{
				onStart: (runId) => {
					controller.runId = runId;
				},
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
				onTodo: (items) => {
					m.todo = items;
					repaint();
				},
				onApproval: (evt) => {
					const decide = addApprovalCard(m, evt);
					repaint();
					scrollToBottom();
					hooks.onApproval?.(evt, decide);
				},
				onQuestion: (evt) => {
					addQuestionCard(m, evt);
					repaint();
					scrollToBottom();
				},
				onQuestionDone: (id) => {
					refs.get(m)?.cards.find((c) => c.id === id)?.expire?.();
				},
				onFallback: ({ from, to, reason }) => {
					m.fallback = { from, to, reason };
					toast(`${from} ${reason}; sigo con ${to}`);
					repaint();
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
				onDone: ({ content, agent, usage, context, route, stats, fallback }) => {
					if (typeof content === "string" && content) m.content = content;
					if (usage?.turns) m.usage = usage;
					if (context?.used) m.context = context;
					if (route?.model) m.route = route;
					if (stats && typeof stats === "object") m.stats = stats;
					if (fallback?.to) m.fallback = fallback;
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
		// Saliste del chat (detachGeneration) o se cortó la conexión (cambiaste de app en el teléfono):
		// la respuesta sigue en el servidor, que la guarda entera en el chat. Aquí no se guarda el trozo.
		if ((controller.detached || err.connectionLost) && controller.runId) {
			cancelAnimationFrame(raf);
			refs.get(m)?.cards.forEach((c) => c.cancel?.());
			refs.get(m)?.root.remove();
			list.splice(list.indexOf(m), 1);
			if (state.controller === controller) {
				state.controller = null;
				setBusy(false);
			}
			panels.idle();
			markLast();
			hooks.onDone?.(m);
			if (sessionId === state.activeId && list === state.messages) watchBackgroundRun(sessionId);
			return;
		}
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
	if (m.stopped && !m.content && !m.tools.length && !m.todo?.length) {
		refs.get(m)?.root.remove();
		list.splice(list.indexOf(m), 1);
	} else {
		if (m.tools.length > 3) refs.get(m)?.steps.classList.add("collapsed");
		// El pintado final colorea el código y puede crecer: se mantiene pegado al final.
		const stick = followingBottom();
		paintAssistant(m);
		if (stick && list === state.messages) scrollToBottom();
	}
	if (state.controller === controller) {
		state.controller = null;
		setBusy(false);
	}
	panels.idle();
	markLast();
	hooks.onDone?.(m);
	if (list === state.messages) refreshContextMeter();
	await persist(sessionId, list);
	if (!voice && prefs.autoRead && m.content && !m.error) readAloud(m);
}

/** «Detener» (botón, Escape, interrumpir la voz): cancela de verdad la respuesta en el servidor. */
export function stopGeneration() {
	const runId = state.controller?.runId || waiting?.runId;
	if (runId) api("/api/chat/stop", { method: "POST", json: { runId } }).catch(() => {});
	state.controller?.abort();
}

/** Salir del chat a mitad de respuesta (abrir otro, un proyecto, uno nuevo): la respuesta sigue sola. */
export function detachGeneration() {
	if (waiting) {
		waiting.cancelled = true;
		waiting = null;
		if (!state.controller) setBusy(false);
	}
	if (!state.controller) return;
	state.controller.detached = true;
	state.controller.abort();
}

/** Respuesta que sigue en el servidor sin la web y que se está esperando ({ sessionId, runId }). */
let waiting = null;

/**
 * Espera a que termine una respuesta que sigue en el servidor sin esta web (saliste de la app o del chat)
 * y luego recarga el chat, donde el servidor ya la guardó. Mientras, el chat queda ocupado con un aviso
 * y «Detener» la cancela. Si abres otro chat, deja de esperar (al volver se mira otra vez).
 */
export async function watchBackgroundRun(sessionId) {
	if (!sessionId || waiting?.sessionId === sessionId || state.controller) return;
	const me = { sessionId, runId: "", cancelled: false };
	let placeholder = null;
	let failures = 0;
	try {
		while (!me.cancelled && state.activeId === sessionId && (!waiting || waiting === me)) {
			let run;
			try {
				run = (await api("/api/chat/runs")).runs?.find((r) => r.sessionId === sessionId);
				failures = 0;
			} catch {
				// Sin conexión (el teléfono acaba de volver): se reintenta un rato antes de rendirse.
				if (++failures > 30) break;
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			if (me.cancelled || state.activeId !== sessionId || (waiting && waiting !== me)) break;
			if (!run) {
				if (placeholder) await reloadChat(sessionId);
				break;
			}
			me.runId = run.runId;
			if (!placeholder) {
				waiting = me;
				const pm = { role: "assistant", content: `_${state.name || "Aku"} sigue respondiendo…_`, tools: [], streaming: true };
				placeholder = buildAssistant(pm);
				paintAssistant(pm);
				messagesBox.append(placeholder);
				scrollToBottom();
				setBusy(true);
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	} finally {
		placeholder?.remove();
		if (waiting === me) {
			waiting = null;
			if (!state.controller) setBusy(false);
		}
	}
}

/** Vuelve a leer el chat del servidor (con la respuesta que guardó él) si sigue a la vista. */
async function reloadChat(sessionId) {
	try {
		const d = await api(`/api/chat-sessions/${encodeURIComponent(sessionId)}`);
		if (state.activeId !== sessionId) return;
		state.messages = (d.session.messages || []).map(fromServer);
		renderThread();
		requestAnimationFrame(() => scrollToBottom());
		refreshContextMeter();
	} catch (err) {
		toast(`No pude recargar el chat: ${err.message}`, "error");
	}
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
/** Lo que se le manda al pulsar «Continuar» en una respuesta que quedó a medias. */
const CONTINUE_TEXT = "Te cerraste antes de terminar tu respuesta anterior. Sigue donde quedaste: revisa lo que ya hiciste (los pasos y la lista de tareas) y termina lo que falta, sin repetir lo que ya está hecho.";

export function initComposer() {
	window.addEventListener("aku:continue", () => sendMessage(CONTINUE_TEXT));
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
	// Vuelves a la app (teléfono): si el chat abierto siguió respondiendo sin la web, se espera y se recarga.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && state.activeId && !state.controller) watchBackgroundRun(state.activeId);
	});
	$("#attach-btn").onclick = (e) =>
		openMenu(e.currentTarget, [
			{ label: "Añadir archivos", icon: "file", onClick: () => $("#file-input").click() },
			{ label: "Agregar carpeta", icon: "folder", onClick: () => $("#folder-input").click() },
		]);
	$("#file-input").onchange = (e) => {
		addFiles([...e.target.files]);
		e.target.value = "";
	};
	$("#folder-input").onchange = (e) => {
		addFolder([...e.target.files]);
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
