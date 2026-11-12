// Nombre y sugerencias, y la ventana de Ajustes (general, modelo, voz, conexiones…).
import * as projects from "./projects.js";
import { icon } from "./icons.js";
import { api } from "./api.js";
import { escapeHtml } from "./markdown.js";
import { listVoices, Speaker, voiceSupport } from "./voice.js";
import { initExtensions, onSettingsTab, promptDialog } from "./extensions.js";
import { initPrompts, loadPrompts } from "./prompts.js";
import { initSetup, mountStorageForm, openSetup } from "./setup.js";
import { mountModelForm } from "./modelForm.js";
import { mountModelSettings } from "./modelSettings.js";
import { initAgents, loadAgents } from "./agents.js";
import { $, $$, applyTheme, closeMenu, confirmDialog, copyText, el, openMenu, prefs, savePrefs, setTheme, toast } from "./ui.js";
import { state } from "./state.js";
import { renderThread, updateEmpty } from "./messages.js";
import { sendMessage, setStatus } from "./chat.js";
import { paintPermissions } from "./permissions.js";
import { refreshContextMeter } from "./contextMeter.js";
import { openRoom, paintRoomBar } from "./rooms.js";
import { chatMenu, closeSidebarMobile, loadSessions, newChat, openChat, openOverview, openProject, paintSidebar, refreshModelInfo, setDocTitle } from "./sidebar.js";
import { ttsSettings } from "./voiceMode.js";

// ───────────────────────────── identidad ─────────────────────────────

export function paintIdentity() {
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
	state.placeholder = window.matchMedia("(max-width: 680px)").matches
		? `Pregúntale algo a ${state.name}`
		: `Pregúntale o pídele algo a ${state.name} (escribe / para ver los comandos)`;
	if (!state.activeId) setDocTitle();
	updateEmpty();
	paintSuggestions();
}

export const SUGGESTIONS = [
	{ icon: "music", text: "Pon música tranquila en YouTube", pc: true },
	{ icon: "cpu", text: "¿Cómo está mi PC?", pc: true },
	{ icon: "globe", text: "¿Qué noticias hay hoy?" },
	{ icon: "bell", text: "Recuérdame tomar agua en 1 hora" },
	{ icon: "window", text: "¿Qué ventanas tengo abiertas?", pc: true },
];

const PLAN_SUGGESTIONS = [
	{ icon: "file", text: "Analiza este proyecto y haz un plan de mejora" },
	{ icon: "search", text: "Investiga las opciones antes de decidir" },
	{ icon: "check", text: "Haz un plan paso a paso para mi próxima tarea" },
];

const MODE_SUGGESTIONS = {
	code: [
		{ icon: "braces", text: "Revisa este proyecto y busca errores" },
		{ icon: "file", text: "Explica cómo está organizado este proyecto" },
		{ icon: "check", text: "Corre las pruebas y arregla lo que falle" },
	],
	hacking: [
		{ icon: "shield", text: "Haz un plan de pruebas para mi VPS" },
		{ icon: "globe", text: "Revisa la seguridad de mi web autorizada" },
		{ icon: "search", text: "Busca CVE de los servicios de mi servidor" },
	],
};

export function paintSuggestions() {
	// Las sugerencias del PC solo en Windows: en un servidor (Docker, Kali) no hay escritorio que manejar.
	const windows = (state.settings?.platform ?? "win32") === "win32";
	const pc = windows && state.mode === "chat" && state.settings?.pcControl !== false && state.settings?.autonomousMode !== false;
	const suggestions = state.permissions === "plan" ? PLAN_SUGGESTIONS : state.mode === "chat" ? SUGGESTIONS.filter((x) => pc || !x.pc) : (MODE_SUGGESTIONS[state.mode] || []);
	const box = $("#suggestions");
	box.innerHTML = "";
	for (const s of suggestions) {
		const b = el("button", "suggestion", `${icon(s.icon)}<span></span>`);
		b.type = "button";
		$("span", b).textContent = s.text;
		b.onclick = () => sendMessage(s.text);
		box.append(b);
	}
}

export async function loadSettings() {
	const [s, llm, profile] = await Promise.all([api("/api/settings"), api("/api/llm-config"), api("/api/user-profile")]);
	state.settings = s;
	state.llm = llm;
	paintPermissions();
	state.profile = profile || {};
	state.name = s.assistantName || "Aku";
	$("#model-name").textContent = llm.model || "sin configurar";
	paintIdentity();
	// Otro modelo puede tener otro tamaño de contexto.
	refreshContextMeter();
	return s;
}

// ───────────────────────────── ajustes ─────────────────────────────

export const settingsDlg = $("#settings-dialog");
export let activeTab = "general";

export function selectTab(tab) {
	activeTab = tab;
	$$("#settings-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
	$$("#settings-panel section").forEach((s) => s.classList.toggle("active", s.dataset.panel === tab));
	if (tab === "connections") {
		refreshWhatsApp();
		refreshTelegram();
		refreshGoogle();
	}
	if (tab === "voice") paintVoices();
	if (tab === "profile") loadPrompts();
	if (tab === "agents") loadAgents();
	if (tab === "storage") mountStorageForm($("#storage-form"), { settings: true, onSaved: () => loadSessions() });
	onSettingsTab(tab);
}

export async function openSettings(tab = "general") {
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

export function fillSettings() {
	const s = state.settings;
	const p = state.profile || {};
	applyTheme();
	loadUpdate();
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
	localVoice = v.ttsLocalVoice || "piper-claude";
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

export function paintVision() {
	const s = state.settings;
	$("#set-vision").value = s.vision;
	$("#vision-desc").textContent = `Si el modelo ve imágenes, ${state.name} puede mirar tu pantalla y hacer clic donde haga falta. Ahora mismo: ${s.visionActive ? "tu modelo SÍ puede ver imágenes." : "tu modelo NO puede ver imágenes."}`;
}

// Ajustes → Modelo: el formulario de public/js/modelForm.js (el mismo que la bienvenida).
export let modelForm = null;
export function paintModelForm() {
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
export let tuningPanel = null;
export function paintTuning() {
	const has = Boolean(modelForm?.target().model);
	$("#cfg-tuning-group").hidden = !has;
	if (!has) return;
	if (tuningPanel?.alive()) return tuningPanel.refresh();
	tuningPanel = mountModelSettings($("#cfg-tuning"), { toast, target: () => modelForm.target() });
}

export async function putSettings(patch, okMessage = "Guardado") {
	try {
		state.settings = await api("/api/settings", { method: "PUT", json: patch });
		state.name = state.settings.assistantName || state.name;
		paintIdentity();
		paintPermissions();
		if (okMessage) toast(okMessage);
		return true;
	} catch (err) {
		toast(err.message, "error");
		return false;
	}
}

// Voz (ajustes)
export function paintVoiceFields() {
	$("#stt-server-fields").hidden = $("#set-stt-engine").value !== "server";
	const engine = $("#set-tts-engine").value;
	$("#tts-server-fields").hidden = engine !== "server";
	$("#tts-local-fields").hidden = engine !== "local";
	// Con la voz de Aku se usa la velocidad, pero no la voz del navegador.
	$("#tts-browser-fields").hidden = engine === "server";
	$("#set-tts-voice-browser").closest("label").hidden = engine === "local";
	if (engine === "local") loadLocalVoices();
}

// Voz de Aku sin internet: elegir, descargar y borrar voces.
let localVoice = "piper-claude";
let localTimer = 0;

const mb = (n) => `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;

export async function loadLocalVoices() {
	clearTimeout(localTimer);
	try {
		paintLocalVoices((await api("/api/voice/local")).voices);
	} catch (err) {
		$("#local-voices").textContent = err.message;
	}
}

function paintLocalVoices(voices) {
	const box = $("#local-voices");
	const busy = (v) => v.state && v.state.phase !== "error";
	box.replaceChildren(
		...voices.map((v) => {
			const row = el("label", "local-voice");
			const radio = el("input");
			Object.assign(radio, { type: "radio", name: "local-voice", value: v.id, checked: v.id === localVoice });
			radio.onchange = () => (localVoice = v.id);
			const text = el("span", "lv-text");
			text.append(el("strong", "", escapeHtml(v.label)), el("small", "", escapeHtml(`${v.hint} · ${mb(v.size)}`)));
			const side = el("span", "lv-side");
			if (busy(v)) {
				const pct = v.state.total ? Math.floor((v.state.received / v.state.total) * 100) : 0;
				side.textContent = v.state.phase === "extracting" ? "Preparando…" : `Descargando ${pct} %`;
			} else if (v.installed) {
				const del = el("button", "btn sm ghost", "Borrar");
				del.type = "button";
				del.onclick = async (e) => {
					e.preventDefault();
					if (!(await confirmDialog({ title: "Borrar voz", text: `¿Borrar la voz «${v.label}»? Podrás volver a descargarla.`, ok: "Borrar", danger: true }))) return;
					try {
						paintLocalVoices((await api("/api/voice/local/remove", { method: "POST", json: { voice: v.id } })).voices);
					} catch (err) {
						toast(err.message, "error");
					}
				};
				side.append(el("span", "lv-ok", "Descargada"), del);
			} else {
				const get = el("button", "btn sm", "Descargar");
				get.type = "button";
				get.onclick = async (e) => {
					e.preventDefault();
					localVoice = v.id;
					try {
						paintLocalVoices((await api("/api/voice/local/install", { method: "POST", json: { voice: v.id } })).voices);
					} catch (err) {
						toast(err.message, "error");
					}
				};
				if (v.state?.phase === "error") side.append(el("span", "lv-error", escapeHtml(v.state.error || "Falló la descarga")));
				side.append(get);
			}
			row.append(radio, text, side);
			return row;
		}),
	);
	// Mientras algo se descarga, se repinta cada segundo (solo con Ajustes abierto).
	if (voices.some(busy) && settingsDlg.open) localTimer = setTimeout(loadLocalVoices, 1000);
}

export function paintVoices() {
	const sel = $("#set-tts-voice-browser");
	const voices = listVoices();
	const base = prefs.lang.slice(0, 2);
	const sorted = [...voices].sort((a, b) => Number(b.lang.startsWith(base)) - Number(a.lang.startsWith(base)) || a.name.localeCompare(b.name));
	sel.innerHTML =
		`<option value="">Automática (la mejor para ${escapeHtml(prefs.lang)})</option>` +
		sorted.map((v) => `<option value="${escapeHtml(v.voiceURI)}">${escapeHtml(v.name)} — ${escapeHtml(v.lang)}</option>`).join("");
	sel.value = voices.some((v) => v.voiceURI === prefs.ttsVoice) ? prefs.ttsVoice : "";
}

export function voicePatch() {
	const patch = {
		sttEngine: $("#set-stt-engine").value,
		sttBaseUrl: $("#set-stt-url").value.trim(),
		sttModel: $("#set-stt-model").value.trim() || "whisper-1",
		ttsEngine: $("#set-tts-engine").value,
		ttsBaseUrl: $("#set-tts-url").value.trim(),
		ttsModel: $("#set-tts-model").value.trim() || "tts-1",
		ttsVoice: $("#set-tts-voice").value.trim() || "alloy",
		ttsLocalVoice: localVoice,
	};
	if ($("#set-stt-key").value.trim()) patch.sttApiKey = $("#set-stt-key").value.trim();
	if ($("#set-tts-key").value.trim()) patch.ttsApiKey = $("#set-tts-key").value.trim();
	return patch;
}

// WhatsApp
export let waTimer = 0;

export async function refreshWhatsApp() {
	clearTimeout(waTimer);
	try {
		paintWhatsApp(await api("/api/whatsapp/status"));
	} catch (err) {
		$("#wa-status").textContent = err.message;
	}
}

export function paintWhatsApp({ status, qrDataUrl }) {
	const labels = {
		idle: "Desconectado.",
		starting: "Iniciando… puede tardar unos segundos.",
		qr: "Escanea este código con tu móvil: WhatsApp → Dispositivos vinculados → Vincular.",
		ready: "Conectado. Ya puedes escribirle a Aku por WhatsApp.",
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

// Telegram
export let tgTimer = 0;

export async function refreshTelegram() {
	clearTimeout(tgTimer);
	try {
		paintTelegram(await api("/api/telegram/status"));
	} catch (err) {
		$("#tg-status").textContent = err.message;
	}
}

/** Fila de la lista de chats: nombre (con textContent: viene de Telegram) y un botón. */
export function telegramRow(title, subtitle, buttonLabel, buttonClass, onClick) {
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

export function paintTelegram(s) {
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
			telegramRow(p.name, `${p.username ? `@${p.username} · ` : ""}quiere hablar con Aku`, "Autorizar", "primary", () =>
				api("/api/telegram/allow", { method: "POST", json: { chatId: p.id } }),
			),
		),
		...s.chats.map((c) =>
			telegramRow(c.name || c.id, "Puede hablar con Aku", "Quitar", "", () =>
				api("/api/telegram/revoke", { method: "POST", json: { chatId: c.id } }),
			),
		),
	);
	// Mientras está conectado y a la vista, se refresca para que aparezcan las solicitudes nuevas.
	if (["starting", "ready", "retrying"].includes(s.state) && settingsDlg.open && activeTab === "connections") {
		tgTimer = setTimeout(refreshTelegram, 4000);
	}
}

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
// Versión de Aku y actualizaciones (Ajustes → General).
let updateTimer = 0;

function paintUpdate(u) {
	const status = $("#update-status");
	const install = $("#update-install");
	const notes = $("#update-notes");
	install.hidden = true;
	notes.hidden = true;
	$("#update-check").disabled = u.phase === "checking" || u.phase === "downloading" || u.phase === "installing";
	if (u.phase === "downloading") {
		const pct = u.total ? Math.floor((u.received / u.total) * 100) : 0;
		status.textContent = `Descargando la versión ${u.latest?.version ?? "nueva"}… ${pct} %`;
	} else if (u.phase === "installing") {
		status.textContent = "Instalando: Aku se cerrará y se volverá a abrir solo en unos segundos.";
	} else if (u.phase === "checking") {
		status.textContent = `Tienes la ${u.current}. Buscando…`;
	} else if (u.available) {
		status.textContent = `Tienes la ${u.current}. Hay una nueva: ${u.latest.version} (${Math.round(u.latest.size / 1024 ** 2)} MB).`;
		if (u.canInstall) install.hidden = false;
		else status.textContent += " Desde el código se actualiza con git pull.";
		if (u.latest.notes) {
			notes.textContent = u.latest.notes;
			notes.hidden = false;
		}
	} else {
		const when = u.checkedAt ? ` (revisado ${new Date(u.checkedAt).toLocaleString()})` : "";
		status.textContent = `Tienes la ${u.current}${u.checkedAt ? `, la más nueva${when}` : ""}.`;
	}
	if (u.phase === "error" && u.error) status.textContent += ` ${u.error}`;
	clearTimeout(updateTimer);
	if (["checking", "downloading"].includes(u.phase) && settingsDlg.open) updateTimer = setTimeout(loadUpdate, 1000);
}

export async function loadUpdate() {
	try {
		paintUpdate(await api("/api/update"));
	} catch (err) {
		$("#update-status").textContent = err.message;
	}
}

/** Busca ahora (botón, o al abrir desde «Buscar actualizaciones» de la bandeja). */
export async function checkUpdateNow() {
	$("#update-status").textContent = "Buscando…";
	try {
		paintUpdate(await api("/api/update/check", { method: "POST" }));
	} catch (err) {
		$("#update-status").textContent = err.message;
	}
}

async function installUpdateNow() {
	const ok = await confirmDialog({
		title: "Actualizar Aku",
		text: "Aku bajará la versión nueva, comprobará que está entera y se cerrará para instalarla. Se volverá a abrir solo; tus chats y ajustes no se tocan.",
		ok: "Actualizar",
	});
	if (!ok) return;
	try {
		paintUpdate(await api("/api/update/install", { method: "POST" }));
		loadUpdate();
	} catch (err) {
		toast(err.message, "error");
	}
}

export function initSettings() {
	$("#update-check").onclick = checkUpdateNow;
	$("#update-install").onclick = installUpdateNow;
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
	$("#voice-save").onclick = async () => {
		const patch = voicePatch();
		if (patch.sttEngine === "server" && !patch.sttBaseUrl) return toast("Escribe la dirección del servidor Whisper.", "error");
		if (patch.ttsEngine === "server" && !patch.ttsBaseUrl) return toast("Escribe la dirección del servidor de voz.", "error");
		if (await putSettings(patch, "Voz guardada")) fillSettings();
	};
	$("#tts-test").onclick = async () => {
		if ($("#set-tts-engine").value !== "browser") {
			if (!(await putSettings(voicePatch(), ""))) return;
		}
		const sp = new Speaker(ttsSettings);
		sp.onError = (err) => toast(`La voz falló: ${err.message}`, "error", 6000);
		sp.speak(`Hola, soy ${state.name}. Así sueno cuando te respondo.`);
	};
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
	$("#g-connect").onclick = connectGoogle;
	$("#g-disconnect").onclick = async () => {
		const ok = await confirmDialog({ title: "Desconectar Google", text: "Aku dejará de ver tu correo y tu calendario, y el permiso se quita también en Google.", ok: "Desconectar", danger: true });
		if (!ok) return;
		try {
			paintGoogle(await api("/api/google/disconnect", { method: "POST" }));
			refreshGoogle();
		} catch (err) {
			toast(err.message, "error");
		}
	};
	settingsDlg.addEventListener("close", () => clearTimeout(googleTimer));
}

// Google (correo y calendario)
let googleTimer = 0;
let googleWaitUntil = 0;
/** Solo se puede conectar desde el navegador de este PC: Google vuelve a 127.0.0.1. */
const onThisPc = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

function paintGoogle(g) {
	const status = $("#g-status");
	if (g.connected) {
		status.textContent = `Conectado${g.email ? ` como ${g.email}` : ""}. Pídele a Aku cosas como «¿tengo correos sin leer?» o «¿qué tengo mañana?».`;
		googleWaitUntil = 0;
	} else if (googleWaitUntil > Date.now()) {
		status.textContent = "Esperando a que aceptes en la ventana de Google…";
	} else {
		status.textContent = g.configured ? "Hay una credencial guardada, pero falta conectar la cuenta." : "Sin conectar.";
	}
	if (!onThisPc()) status.textContent += " Para conectar, abre Aku en el navegador del PC donde corre (Google vuelve a 127.0.0.1).";
	if (g.clientId !== undefined) $("#g-client-id").value = g.clientId || "";
	$("#g-secret-hint").textContent = g.hasSecret ? "Hay un secreto guardado (déjalo vacío para mantenerlo)." : "";
	$("#g-disconnect").hidden = !g.connected;
	$("#g-connect").textContent = g.connected ? "Volver a conectar" : "Conectar";
	$("#g-guide").open = !g.configured;
	clearTimeout(googleTimer);
	if (googleWaitUntil > Date.now() && settingsDlg.open) googleTimer = setTimeout(refreshGoogle, 3000);
}

export async function refreshGoogle() {
	try {
		paintGoogle(await api("/api/google/status"));
	} catch (err) {
		$("#g-status").textContent = err.message;
	}
}

async function connectGoogle() {
	if (!onThisPc()) return toast("Conecta Google desde el navegador del PC donde corre Aku.", "error", 6000);
	// La ventana se abre ya (con el clic), si no el navegador la bloquea; luego se le pone la dirección.
	const win = window.open("about:blank", "_blank");
	try {
		const r = await api("/api/google/connect", { method: "POST", json: { clientId: $("#g-client-id").value.trim(), clientSecret: $("#g-client-secret").value.trim() } });
		$("#g-client-secret").value = "";
		if (win) win.location.href = r.url;
		else location.href = r.url;
		googleWaitUntil = Date.now() + 5 * 60_000;
		refreshGoogle();
	} catch (err) {
		win?.close();
		toast(err.message, "error", 6000);
	}
}
