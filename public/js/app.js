// Shiro — interfaz de chat. Cada parte está en su módulo; aquí se arranca todo.
import * as projects from "./projects.js";
import { hydrateIcons } from "./icons.js";
import { openSetup } from "./setup.js";
import { $, applyTheme, closeMenu, isMobile, openMenuEl, prefs, toast } from "./ui.js";
import { input, state } from "./state.js";
import { initMessages } from "./messages.js";
import { initComposer, paintComposer, stopGeneration } from "./chat.js";
import { refreshAgents } from "./rooms.js";
import { initSidebar, loadSessions, newChat, openSearch, route } from "./sidebar.js";
import { initSettings, loadSettings, paintSuggestions } from "./settings.js";
import { initReminders, pollNotifications } from "./reminders.js";
import { initVoice, reader, stopReading, voice } from "./voiceMode.js";

// Botones y eventos de cada parte, en el mismo orden que cuando todo estaba en este archivo.
initMessages();
initComposer();
initSidebar();
initSettings();
initReminders();
initVoice();

// ───────────────────────────── atajos de teclado ─────────────────────────────

const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

document.addEventListener("keydown", (e) => {
	const mod = e.ctrlKey || e.metaKey;
	const k = e.key.toLowerCase();
	if (mod && e.shiftKey && k === "o") {
		e.preventDefault();
		newChat();
	} else if (mod && !e.shiftKey && k === "k") {
		e.preventDefault();
		openSearch();
	} else if (mod && e.shiftKey && e.code === "Space") {
		e.preventDefault();
		voice.active ? voice.close() : voice.open();
	} else if (e.key === "Escape") {
		if (voice.active) return voice.close();
		if (openMenuEl) return closeMenu();
		if (document.querySelector("dialog[open]")) return;
		if (state.busy) stopGeneration();
		else if (reader.msg) stopReading();
	} else if (e.key === "/" && !mod && !isTyping(e.target) && !document.querySelector("dialog[open]")) {
		e.preventDefault();
		input.focus();
	}
});

window.addEventListener("resize", () => {
	if (openMenuEl) closeMenu();
});

// ───────────────────────────── inicio ─────────────────────────────

async function init() {
	hydrateIcons();
	applyTheme();
	if (prefs.sidebarCollapsed && !isMobile()) $("#app").classList.add("sb-collapsed");
	paintComposer();
	paintSuggestions();
	await Promise.all([projects.loadProjects(), loadSessions(), loadSettings().catch((err) => toast(err.message, "error")), refreshAgents()]);
	route();
	if (state.settings?.needsSetup) openSetup({ firstRun: true });
	setInterval(pollNotifications, 20_000);
	if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
	input.focus();
}

init();
