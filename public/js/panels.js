// Paneles a la derecha del chat: el navegador de Shiro (en vivo) y la terminal compartida.
import { api, streamEvents } from "./api.js";

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

const HISTORY_KEY = "shiro.termHistory";
const MAX_DOM_BLOCKS = 300;

function createTerminalPane(toast) {
	const out = $("#term-out");
	const input = $("#term-cmd");
	const promptEl = $("#term-prompt");
	const stopBtn = $("#terminal-stop");
	const shellEl = $("#terminal-shell");
	const blocks = new Map();
	let cwd = "";
	let shell = "";
	let history = [];
	try {
		history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
	} catch {}
	let hIdx = history.length;

	const promptText = (dir) => (!shell || /powershell/i.test(shell) ? `PS ${dir}>` : `${dir}$`);
	const nearBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 60;
	const span = (cls, text) => {
		const s = document.createElement("span");
		s.className = cls;
		s.textContent = text;
		return s;
	};

	function paintPrompt() {
		promptEl.textContent = cwd ? promptText(cwd) : "PS>";
		shellEl.textContent = shell;
		stopBtn.disabled = ![...blocks.values()].some((b) => b.running);
	}

	function appendChunk(entry, text, err) {
		const last = entry.o.lastElementChild;
		if (last && last.dataset.err === String(err)) last.textContent += text;
		else {
			const s = span(err ? "term-err" : "", text);
			s.dataset.err = String(err);
			entry.o.append(s);
		}
	}

	function endBlock(entry, exitCode) {
		entry.running = false;
		entry.el.classList.remove("running");
		if (entry.system || exitCode === 0 || exitCode === undefined) return;
		entry.el.append(span("term-exit", exitCode === null ? "interrumpido" : `terminó con código ${exitCode}`));
	}

	function addBlock(b) {
		const el = document.createElement("div");
		el.className = `term-block${b.by === "system" ? " system" : ""}${b.running ? " running" : ""}`;
		if (b.by !== "system") {
			const cmd = document.createElement("div");
			cmd.className = "term-cmd";
			cmd.append(span("term-ps", promptText(b.cwd)), " ", span("term-text", b.command));
			if (b.by === "shiro") cmd.append(span("term-by", "Shiro"));
			el.append(cmd);
		}
		const o = document.createElement("div");
		o.className = "term-output";
		el.append(o);
		const entry = { el, o, running: b.running, system: b.by === "system" };
		blocks.set(b.id, entry);
		for (const c of b.chunks || []) appendChunk(entry, c.text, c.err);
		out.append(el);
		if (!b.running) endBlock(entry, b.exitCode);
		while (out.children.length > MAX_DOM_BLOCKS) out.firstElementChild.remove();
	}

	const stream = liveStream("/api/terminal/stream", (e) => {
		const stick = nearBottom();
		if (e.type === "snapshot") {
			out.textContent = "";
			blocks.clear();
			cwd = e.cwd;
			shell = e.shell;
			for (const b of e.blocks) addBlock(b);
		} else if (e.type === "block") {
			addBlock(e.block);
		} else if (e.type === "out") {
			const entry = blocks.get(e.id);
			if (entry) appendChunk(entry, e.text, e.err);
		} else if (e.type === "end") {
			const entry = blocks.get(e.id);
			if (entry) endBlock(entry, e.exitCode);
			cwd = e.cwd;
		}
		paintPrompt();
		if (stick || e.type === "snapshot" || e.type === "block") out.scrollTop = out.scrollHeight;
	});

	const post = (path, json) => api(path, { method: "POST", json }).catch((err) => toast(err.message, "error", 6000));

	$("#term-form").addEventListener("submit", (e) => {
		e.preventDefault();
		const command = input.value;
		if (!command.trim()) return;
		if (history[history.length - 1] !== command) history.push(command);
		history = history.slice(-100);
		hIdx = history.length;
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
		} catch {}
		input.value = "";
		post("/api/terminal/run", { command });
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			e.preventDefault();
			hIdx = Math.max(0, Math.min(history.length, hIdx + (e.key === "ArrowUp" ? -1 : 1)));
			input.value = history[hIdx] ?? "";
			input.setSelectionRange(input.value.length, input.value.length);
		} else if (e.ctrlKey && e.key.toLowerCase() === "c" && input.selectionStart === input.selectionEnd) {
			e.preventDefault();
			if (!stopBtn.disabled) post("/api/terminal/stop");
			input.value = "";
		} else if (e.ctrlKey && e.key.toLowerCase() === "l") {
			e.preventDefault();
			post("/api/terminal/clear");
		}
	});
	// Clic en la salida (sin seleccionar texto) = escribir un comando.
	out.addEventListener("mouseup", () => {
		if (!window.getSelection()?.toString()) input.focus();
	});
	stopBtn.onclick = () => post("/api/terminal/stop");
	$("#terminal-clear").onclick = () => post("/api/terminal/clear");

	return {
		busy: badge($("#terminal-badge")),
		setActive(on) {
			if (on) {
				stream.start();
				setTimeout(() => input.focus(), 50);
			} else stream.stop();
		},
	};
}

// ───────────────────────────── contenedor ─────────────────────────────

export function initPanels({ toast }) {
	const app = $("#app");
	const dock = $("#dock");
	const prefs = { browser: false, terminal: false, width: 0, ...readPrefs() };
	const panes = { browser: createBrowserPane(toast), terminal: createTerminalPane(toast) };
	const els = { browser: $("#browser-pane"), terminal: $("#terminal-pane") };
	const buttons = { browser: $("#browser-btn"), terminal: $("#terminal-btn") };

	const applyWidth = () => {
		if (prefs.width) dock.style.width = `${prefs.width}px`;
	};

	function show(name, open) {
		if (!els[name].hidden === open) return;
		els[name].hidden = !open;
		buttons[name].classList.toggle("active", open);
		buttons[name].setAttribute("aria-pressed", String(open));
		dock.hidden = els.browser.hidden && els.terminal.hidden;
		app.classList.toggle("dock-open", !dock.hidden);
		panes[name].setActive(open);
		prefs[name] = open;
		savePrefs(prefs);
	}

	buttons.browser.onclick = () => show("browser", els.browser.hidden);
	buttons.terminal.onclick = () => show("terminal", els.terminal.hidden);
	$("#browser-hide").onclick = () => show("browser", false);
	$("#terminal-hide").onclick = () => show("terminal", false);

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
	if (prefs.browser) show("browser", true);
	if (prefs.terminal) show("terminal", true);

	return {
		show,
		/** Eventos de herramientas del chat: abre el panel que Shiro está usando y lo indica. */
		onTool(evt) {
			// Claude Code enseña su progreso en el panel Terminal.
			const name = evt.name === "browser" || evt.name === "terminal" ? evt.name : evt.name === "claude_code" ? "terminal" : null;
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
