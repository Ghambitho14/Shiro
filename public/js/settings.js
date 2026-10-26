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
	state.placeholder = `Pregúntale o pídele algo a ${state.name} (escribe / para ver los comandos)`;
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

export function paintSuggestions() {
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

export async function loadSettings() {
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

export const settingsDlg = $("#settings-dialog");
export let activeTab = "general";

export function selectTab(tab) {
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
	const server = $("#set-tts-engine").value === "server";
	$("#tts-server-fields").hidden = !server;
	$("#tts-browser-fields").hidden = server;
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

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initSettings() {
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
		if ($("#set-tts-engine").value === "server") {
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
}
