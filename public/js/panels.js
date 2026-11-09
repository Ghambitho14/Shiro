// Paneles a la derecha del chat: el navegador de Shiro (en vivo), la terminal compartida y la oficina (ayudantes).
import { api, streamEvents } from "./api.js";
import { hydrateIcons } from "./icons.js";

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFS_KEY = "shiro.panels";

function readPrefs() {
	try {
		return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
	} catch {
		return {};
	}
}

function savePrefs(p) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(p));
	} catch {}
}

/** Flujo en vivo que se reconecta solo mientras el panel está abierto. */
function liveStream(url, onEvent) {
	let ctrl = null;
	let running = false;
	async function loop() {
		let retry = 0;
		while (running) {
			ctrl = new AbortController();
			try {
				await streamEvents(url, onEvent, ctrl.signal);
				retry = 0;
			} catch {
				/* sin conexión: se reintenta */
			}
			if (!running) break;
			await sleep(Math.min(8000, 600 * 2 ** retry++));
		}
	}
	return {
		start() {
			if (running) return;
			running = true;
			loop();
		},
		stop() {
			running = false;
			ctrl?.abort();
		},
	};
}

/** Etiqueta "Shiro está usando…" en la cabecera de un panel. */
function badge(el) {
	return (label) => {
		el.hidden = !label;
		if (label) $(".pane-badge-text", el).textContent = label;
	};
}

// ───────────────────────────── navegador ─────────────────────────────

const SPECIAL_KEYS = new Set([
	"Enter",
	"Backspace",
	"Tab",
	"Escape",
	"Delete",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"Insert",
	"F5",
]);

function createBrowserPane(toast) {
	const view = $("#browser-view");
	const img = $("#browser-frame");
	const empty = $("#browser-empty");
	const urlInput = $("#browser-url");
	const loading = $("#browser-loading");
	let state = { open: false, url: "", title: "", loading: false };
	let frame = { width: 0, height: 0 };
	let active = false;

	const paint = () => {
		if (!state.open) {
			img.hidden = true;
			empty.hidden = false;
		}
		if (document.activeElement !== urlInput) urlInput.value = state.url && state.url !== "about:blank" ? state.url : "";
		loading.hidden = !state.loading;
		view.title = state.title || "";
	};

	const stream = liveStream("/api/browser/stream", (e) => {
		if (e.type === "frame") {
			img.src = `data:image/jpeg;base64,${e.data}`;
			frame = { width: e.width, height: e.height };
			img.hidden = false;
			empty.hidden = true;
		} else if (e.type === "state") {
			state = e;
			paint();
		}
	});

	const action = (body) => api("/api/browser/action", { method: "POST", json: body }).catch((err) => toast(err.message, "error", 6000));

	// Los eventos se mandan en orden, uno detrás de otro.
	let chain = Promise.resolve();
	const send = (ev) => {
		if (!state.open) return;
		chain = chain.then(() => api("/api/browser/input", { method: "POST", json: ev })).catch(() => {});
	};

	$("#browser-form").addEventListener("submit", (e) => {
		e.preventDefault();
		const url = urlInput.value.trim();
		if (!url) return;
		urlInput.blur();
		action({ action: "navigate", url });
	});
	urlInput.addEventListener("focus", () => urlInput.select());
	urlInput.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			urlInput.blur();
			paint();
		}
	});
	$("#browser-back").onclick = () => state.open && action({ action: "back" });
	$("#browser-forward").onclick = () => state.open && action({ action: "forward" });
	$("#browser-reload").onclick = () => state.open && action({ action: "reload" });
	$("#browser-shutdown").onclick = () => state.open && action({ action: "close" });

	/** Posición del ratón en píxeles de la página (la imagen se ajusta al panel). */
	function toPage(e) {
		const r = view.getBoundingClientRect();
		const w = frame.width || r.width;
		const h = frame.height || r.height;
		const scale = Math.min(r.width / w, r.height / h) || 1;
		const x = (e.clientX - r.left) / scale;
		const y = (e.clientY - r.top) / scale;
		if (x < 0 || y < 0 || x > w || y > h) return null;
		return { x: Math.round(x), y: Math.round(y) };
	}

	view.addEventListener("mousedown", () => view.focus());
	view.addEventListener("click", (e) => {
		const p = toPage(e);
		if (p) send({ type: "click", ...p, button: "left", clickCount: Math.min(e.detail || 1, 3) });
	});
	view.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const p = toPage(e);
		if (p) send({ type: "click", ...p, button: "right" });
	});

	let wheel = null;
	view.addEventListener(
		"wheel",
		(e) => {
			if (!state.open) return;
			e.preventDefault();
			const p = toPage(e);
			if (!p) return;
			const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? view.clientHeight : 1;
			if (!wheel) {
				wheel = { ...p, deltaX: 0, deltaY: 0 };
				setTimeout(() => {
					send({ type: "wheel", ...wheel });
					wheel = null;
				}, 60);
			}
			wheel.deltaX += e.deltaX * unit;
			wheel.deltaY += e.deltaY * unit;
		},
		{ passive: false },
	);

	// Letras seguidas se agrupan en un solo envío.
	let pendingText = "";
	let textTimer = 0;
	const flushText = () => {
		textTimer = 0;
		if (pendingText) send({ type: "text", text: pendingText });
		pendingText = "";
	};
	view.addEventListener("keydown", (e) => {
		if (e.isComposing || !state.open) return;
		const mod = e.ctrlKey || e.metaKey || e.altKey;
		if (!mod && e.key.length === 1) {
			e.preventDefault();
			e.stopPropagation();
			pendingText += e.key;
			if (!textTimer) textTimer = setTimeout(flushText, 30);
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // lo maneja "paste"
		if (SPECIAL_KEYS.has(e.key) || (mod && e.key.length === 1)) {
			e.preventDefault();
			e.stopPropagation();
			flushText();
			send({ type: "key", key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
		}
	});
	view.addEventListener("paste", (e) => {
		const text = e.clipboardData?.getData("text");
		if (!text || !state.open) return;
		e.preventDefault();
		flushText();
		send({ type: "text", text: text.slice(0, 5000) });
	});

	// La página se adapta al tamaño del panel.
	let sizeTimer = 0;
	let lastSize = "";
	const syncSize = () => {
		clearTimeout(sizeTimer);
		sizeTimer = setTimeout(() => {
			const width = view.clientWidth;
			const height = view.clientHeight;
			if (!active || width < 50 || height < 50) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const key = `${width}x${height}@${dpr}`;
			if (key === lastSize) return;
			lastSize = key;
			action({ action: "viewport", width, height, dpr });
		}, 200);
	};
	new ResizeObserver(syncSize).observe(view);

	return {
		busy: badge($("#browser-badge")),
		setActive(on) {
			active = on;
			if (on) {
				stream.start();
				syncSize();
			} else stream.stop();
		},
	};
}

// ───────────────────────────── terminal ─────────────────────────────

const TERM_THEME = {
	background: "#0f1115",
	foreground: "#d7dae0",
	cursor: "#d7dae0",
	cursorAccent: "#0f1115",
	selectionBackground: "rgba(127, 180, 255, 0.35)",
};

function createTerminalPane(toast) {
	const screen = $("#term-screen");
	const stopBtn = $("#terminal-stop");
	const shellEl = $("#terminal-shell");
	const attentionBar = $("#term-attention");
	const external = $("#term-external");
	const blocks = new Map();
	let term = null;
	let fit = null;
	let loading = null;
	let active = false;
	let busy = false;

	const post = (path, json) => api(path, { method: "POST", json }).catch((err) => toast(err.message, "error", 6000));

	// ── tareas de Claude Code (no pasan por la consola: van en una franja aparte) ──

	const span = (cls, text) => {
		const s = document.createElement("span");
		s.className = cls;
		s.textContent = text;
		return s;
	};

	function paintStop() {
		stopBtn.disabled = !busy && ![...blocks.values()].some((b) => b.running);
	}

	function appendChunk(entry, text, err) {
		const last = entry.o.lastElementChild;
		if (last && last.dataset.err === String(err)) last.textContent += text;
		else {
			const s = span(err ? "term-err" : "", text);
			s.dataset.err = String(err);
			entry.o.append(s);
		}
		external.scrollTop = external.scrollHeight;
	}

	function endBlock(entry, exitCode) {
		entry.running = false;
		entry.el.classList.remove("running");
		if (exitCode === 0 || exitCode === undefined) return;
		entry.el.append(span("term-exit", exitCode === null ? "interrumpido" : `terminó con código ${exitCode}`));
	}

	function addBlock(b) {
		const el = document.createElement("div");
		el.className = `term-block${b.running ? " running" : ""}`;
		const title = document.createElement("div");
		title.className = "term-cmd";
		title.append(span("term-text", b.command));
		el.append(title);
		const o = document.createElement("div");
		o.className = "term-output";
		el.append(o);
		const entry = { el, o, running: b.running };
		blocks.set(b.id, entry);
		for (const c of b.chunks || []) appendChunk(entry, c.text, c.err);
		external.append(el);
		external.hidden = false;
		if (!b.running) endBlock(entry, b.exitCode);
	}

	function clearBlocks(keepRunning) {
		for (const [id, entry] of blocks) {
			if (keepRunning && entry.running) continue;
			entry.el.remove();
			blocks.delete(id);
		}
		external.hidden = blocks.size === 0;
	}

	// ── la consola ──

	/** La librería pesa: se baja al abrir el panel por primera vez. */
	function loadTerminal() {
		loading ??= (async () => {
			const css = document.createElement("link");
			css.rel = "stylesheet";
			css.href = "/vendor/xterm.css";
			document.head.append(css);
			const [{ Terminal }, { FitAddon }] = await Promise.all([import("/vendor/xterm.mjs"), import("/vendor/xterm-fit.mjs")]);
			term = new Terminal({
				allowProposedApi: true,
				cursorBlink: true,
				scrollback: 5000,
				scrollOnEraseInDisplay: true,
				fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Consolas, monospace",
				fontSize: 13,
				theme: TERM_THEME,
			});
			fit = new FitAddon();
			term.loadAddon(fit);
			term.open(screen);
			term.onData(send);
			term.onBinary(send);
			term.attachCustomKeyEventHandler(onKey);
			new ResizeObserver(syncSize).observe(screen);
		})();
		return loading;
	}

	// Lo tecleado va en orden: lo que llega mientras se manda algo se junta en el siguiente envío.
	let pending = "";
	let sending = false;
	async function send(data) {
		pending += data;
		if (sending) return;
		sending = true;
		while (pending) {
			const chunk = pending;
			pending = "";
			await post("/api/terminal/input", { data: chunk });
		}
		sending = false;
	}

	function onKey(e) {
		if (e.type !== "keydown") return true;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		// Ctrl+C con texto marcado copia; sin marcar, interrumpe (lo normal en una terminal).
		if (mod && !e.altKey && key === "c" && term.hasSelection()) {
			copyText(term.getSelection());
			term.clearSelection();
			return false;
		}
		// Ctrl+V: que lo haga el navegador; la terminal recibe el evento de pegar.
		if (mod && !e.altKey && key === "v") return false;
		return true;
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Sin https (por Tailscale) el navegador no da acceso al portapapeles: se hace a la antigua.
			const ta = document.createElement("textarea");
			ta.value = text;
			document.body.append(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
	}

	// Las teclas son de la terminal: Esc o Ctrl+K no deben activar los atajos de Shiro.
	screen.addEventListener("keydown", (e) => e.stopPropagation());

	let sizeTimer = 0;
	let lastSize = "";
	function syncSize() {
		clearTimeout(sizeTimer);
		sizeTimer = setTimeout(() => {
			if (!active || !term || screen.clientWidth < 50 || screen.clientHeight < 30) return;
			fit.fit();
			const key = `${term.cols}x${term.rows}`;
			if (key === lastSize) return;
			lastSize = key;
			post("/api/terminal/resize", { cols: term.cols, rows: term.rows });
		}, 80);
	}

	function setAttention(attention) {
		attentionBar.hidden = !attention;
		if (!attention) return;
		$("#term-attention-text").textContent = `«${attention.prompt}» Escríbela aquí: Aku no la ve.`;
		// Que no acabe escrita por error en la caja del chat.
		term?.focus();
	}

	function setState(e) {
		busy = e.busy;
		shellEl.textContent = e.shell;
		paintStop();
	}

	const stream = liveStream("/api/terminal/stream", (e) => {
		if (e.type === "snapshot") {
			setState(e);
			setAttention(e.attention);
			clearBlocks(false);
			for (const b of e.blocks) addBlock(b);
			if (e.windowsBuild) term.options.windowsPty = { backend: "conpty", buildNumber: e.windowsBuild };
			term.reset();
			term.resize(e.cols, e.rows);
			lastSize = "";
			term.write(e.data, syncSize);
		} else if (e.type === "data") {
			term.write(e.data);
		} else if (e.type === "state") {
			setState(e);
		} else if (e.type === "attention") {
			setAttention(e.attention);
		} else if (e.type === "notice") {
			toast(e.text, "info", 6000);
		} else if (e.type === "clear") {
			term.clear();
			clearBlocks(true);
		} else if (e.type === "block") {
			addBlock(e.block);
		} else if (e.type === "out") {
			const entry = blocks.get(e.id);
			if (entry) appendChunk(entry, e.text, e.err);
		} else if (e.type === "end") {
			const entry = blocks.get(e.id);
			if (entry) endBlock(entry, e.exitCode);
		}
		paintStop();
	});

	attentionBar.onclick = () => term?.focus();
	stopBtn.onclick = () => post("/api/terminal/stop");
	$("#terminal-clear").onclick = () => post("/api/terminal/clear");

	return {
		busy: badge($("#terminal-badge")),
		focus() {
			loadTerminal().then(() => term.focus());
		},
		setActive(on) {
			active = on;
			if (!on) return stream.stop();
			loadTerminal()
				.then(() => {
					if (!active) return;
					stream.start();
					syncSize();
				})
				.catch((err) => toast(`No pude abrir la terminal: ${err.message}`, "error", 6000));
		},
	};
}

// ───────────────────────────── oficina ─────────────────────────────

const STATUS_TEXT = { working: "Trabajando", done: "Terminó", error: "Falló", stopped: "Detenido" };

/** "45 s", "3 min 10 s". */
function elapsed(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

function createOfficePane(toast) {
	const list = $("#office-desks");
	const empty = $("#office-empty");
	const count = $("#office-count");
	const stopAll = $("#office-stop");
	const desks = new Map();

	const post = (path, json) => api(path, { method: "POST", json }).catch((err) => toast(err.message, "error", 6000));

	function paintDesk(d) {
		let card = list.querySelector(`[data-id="${d.id}"]`);
		if (!card) {
			card = document.createElement("article");
			card.className = "desk";
			card.dataset.id = d.id;
			card.setAttribute("role", "listitem");
			card.innerHTML =
				'<div class="desk-head"><span class="desk-avatar"></span><div class="desk-who"><span class="desk-name"></span><span class="desk-boss"></span></div><span class="desk-status"></span><button class="icon-btn sm desk-stop" title="Detener a este ayudante" data-icon="stop" data-size="sm"></button></div><p class="desk-task"></p><div class="desk-step"><span class="pane-dot"></span><span class="desk-step-text"></span><span class="desk-time"></span></div><details class="desk-result"><summary>Resultado</summary><div class="desk-result-text"></div></details>';
			hydrateIcons(card);
			$(".desk-stop", card).onclick = () => post("/api/office/stop", { id: d.id });
			list.prepend(card);
		}
		card.dataset.status = d.status;
		const avatar = $(".desk-avatar", card);
		avatar.textContent = (d.name.trim()[0] || "?").toUpperCase();
		avatar.style.background = d.color || "";
		$(".desk-name", card).textContent = d.name;
		$(".desk-boss", card).textContent = `ayudante de ${d.boss}`;
		$(".desk-status", card).textContent = STATUS_TEXT[d.status] || d.status;
		$(".desk-stop", card).hidden = d.status !== "working";
		$(".desk-task", card).textContent = d.task;
		$(".desk-task", card).title = d.task;
		$(".desk-step-text", card).textContent = d.status === "working" ? d.step : `${d.step}${d.steps ? ` · ${d.steps} ${d.steps === 1 ? "paso" : "pasos"}` : ""}`;
		const result = $(".desk-result", card);
		result.hidden = !d.result;
		// El texto del modelo se muestra tal cual (sin HTML).
		$(".desk-result-text", card).textContent = d.result || "";
		$(".desk-result summary", card).textContent = d.status === "error" ? "Error" : "Resultado";
	}

	function paintTimes() {
		const now = Date.now();
		for (const d of desks.values()) {
			const t = list.querySelector(`[data-id="${d.id}"] .desk-time`);
			if (t) t.textContent = elapsed((d.endedAt || now) - d.startedAt);
		}
	}

	function paintSummary() {
		const all = [...desks.values()];
		const working = all.filter((d) => d.status === "working").length;
		empty.hidden = all.length > 0;
		list.hidden = all.length === 0;
		stopAll.disabled = working === 0;
		count.textContent = all.length ? (working ? `${working} trabajando` : `${all.length} ${all.length === 1 ? "escritorio" : "escritorios"}`) : "";
	}

	const stream = liveStream("/api/office/stream", (e) => {
		if (e.type === "snapshot") {
			list.textContent = "";
			desks.clear();
			for (const d of e.desks) {
				desks.set(d.id, d);
				paintDesk(d);
			}
		} else if (e.type === "desk") {
			desks.set(e.desk.id, e.desk);
			paintDesk(e.desk);
		} else if (e.type === "remove") {
			desks.delete(e.id);
			list.querySelector(`[data-id="${e.id}"]`)?.remove();
		}
		paintSummary();
		paintTimes();
	});

	// El reloj de cada escritorio avanza mientras el panel está abierto.
	let clock = 0;
	stopAll.onclick = () => post("/api/office/stop", {});
	$("#office-clear").onclick = () => post("/api/office/clear", {});
	paintSummary();

	return {
		busy: badge($("#office-badge")),
		setActive(on) {
			clearInterval(clock);
			if (on) {
				stream.start();
				clock = setInterval(paintTimes, 1000);
			} else stream.stop();
		},
	};
}

// ───────────────────────────── contenedor ─────────────────────────────

export function initPanels({ toast }) {
	const app = $("#app");
	const dock = $("#dock");
	const prefs = { browser: false, terminal: false, office: false, width: 0, ...readPrefs() };
	const panes = { browser: createBrowserPane(toast), terminal: createTerminalPane(toast), office: createOfficePane(toast) };
	const els = { browser: $("#browser-pane"), terminal: $("#terminal-pane"), office: $("#office-pane") };
	const buttons = { browser: $("#browser-btn"), terminal: $("#terminal-btn"), office: $("#office-btn") };

	const applyWidth = () => {
		if (prefs.width) dock.style.width = `${prefs.width}px`;
	};

	// En una ventana mediana no caben barra lateral, chat y panel: la barra se oculta mientras dure
	// el panel, sin guardarlo como preferencia (en el teléfono el panel ya ocupa toda la pantalla).
	let sidebarHiddenForDock = false;
	const fitSidebar = () => {
		if (!dock.hidden && !app.classList.contains("sb-collapsed") && window.matchMedia("(min-width: 861px) and (max-width: 1100px)").matches) {
			app.classList.add("sb-collapsed");
			sidebarHiddenForDock = true;
		} else if (dock.hidden && sidebarHiddenForDock) {
			app.classList.remove("sb-collapsed");
			sidebarHiddenForDock = false;
		}
	};

	function show(name, open) {
		if (!els[name].hidden === open) return;
		els[name].hidden = !open;
		buttons[name].classList.toggle("active", open);
		buttons[name].setAttribute("aria-pressed", String(open));
		dock.hidden = Object.values(els).every((e) => e.hidden);
		app.classList.toggle("dock-open", !dock.hidden);
		fitSidebar();
		panes[name].setActive(open);
		prefs[name] = open;
		savePrefs(prefs);
	}

	for (const name of Object.keys(panes)) {
		buttons[name].onclick = () => {
			show(name, els[name].hidden);
			// Abierto a mano es para usarlo; abierto solo (lo usa Shiro) no le quita el foco al chat.
			if (!els[name].hidden) panes[name].focus?.();
		};
		$(`#${name}-hide`).onclick = () => show(name, false);
	}

	// Arrastrar el borde izquierdo cambia el ancho.
	const resizer = $("#dock-resizer");
	const clampWidth = (w) => Math.round(Math.max(320, Math.min(w, app.clientWidth - 360)));
	resizer.addEventListener("pointerdown", (e) => {
		e.preventDefault();
		resizer.setPointerCapture(e.pointerId);
		app.classList.add("dock-resizing");
		const move = (ev) => {
			prefs.width = clampWidth(app.getBoundingClientRect().right - ev.clientX);
			applyWidth();
		};
		const up = () => {
			resizer.removeEventListener("pointermove", move);
			resizer.removeEventListener("pointerup", up);
			app.classList.remove("dock-resizing");
			savePrefs(prefs);
		};
		resizer.addEventListener("pointermove", move);
		resizer.addEventListener("pointerup", up);
	});
	resizer.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		prefs.width = clampWidth((prefs.width || dock.offsetWidth) + (e.key === "ArrowLeft" ? 32 : -32));
		applyWidth();
		savePrefs(prefs);
	});

	applyWidth();
	for (const name of Object.keys(panes)) if (prefs[name]) show(name, true);

	return {
		show,
		/** Eventos de herramientas del chat: abre el panel que Shiro está usando y lo indica. */
		onTool(evt) {
			// Claude Code enseña su progreso en el panel Terminal; los ayudantes, en la Oficina.
			const name = { browser: "browser", terminal: "terminal", claude_code: "terminal", delegate: "office" }[evt.name] ?? null;
			if (!name) return;
			if (evt.phase === "start") {
				show(name, true);
				panes[name].busy(evt.label);
			} else {
				panes[name].busy("");
			}
		},
	};
}
