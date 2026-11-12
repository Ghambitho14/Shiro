// Recordatorios: la ventana, crear, completar y los avisos.
import { icon } from "./icons.js";
import { api } from "./api.js";
import { Speaker } from "./voice.js";
import { $, closeMenu, el, notifySystem, prefs, toast } from "./ui.js";
import { actionButton } from "./messages.js";
import { closeSidebarMobile } from "./sidebar.js";
import { ttsSettings, voice } from "./voiceMode.js";

// ───────────────────────────── recordatorios ─────────────────────────────

export const remDlg = $("#reminders-dialog");
export const REPEAT = { daily: "cada día", weekly: "cada semana", monthly: "cada mes" };

export function localInputValue(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export async function openReminders() {
	closeMenu();
	closeSidebarMobile();
	const soon = new Date(Date.now() + 60 * 60 * 1000);
	soon.setMinutes(0, 0, 0);
	$("#rem-when").value = localInputValue(soon);
	remDlg.showModal();
	if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
	await Promise.all([loadReminders(), loadCronTasks()]);
}

export async function loadReminders() {
	const list = $("#rem-list");
	try {
		const { reminders = [] } = await api("/api/reminders");
		const sorted = reminders.sort((a, b) => Number(a.completed) - Number(b.completed) || new Date(a.datetime) - new Date(b.datetime));
		if (!sorted.length) {
			list.innerHTML = '<div class="sb-empty">No tienes recordatorios.</div>';
			return;
		}
		list.innerHTML = "";
		for (const r of sorted) {
			const item = el("div", `rem-item${r.completed ? " done" : ""}`, `${icon("bell")}<div class="info"><strong></strong><span></span></div>`);
			$("strong", item).textContent = r.title;
			const when = new Date(r.datetime).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
			$(".info span", item).textContent = `${when}${REPEAT[r.repeat] ? ` · ${REPEAT[r.repeat]}` : ""}${r.completed ? " · hecho" : ""}`;
			if (!r.completed) {
				item.append(
					actionButton("check", "Marcar como hecho", async () => {
						await api(`/api/reminders/${encodeURIComponent(r.id)}`, { method: "POST", json: { action: "complete" } }).catch((e) => toast(e.message, "error"));
						loadReminders();
					}),
				);
			}
			item.append(
				actionButton("trash", "Eliminar", async () => {
					await api(`/api/reminders/${encodeURIComponent(r.id)}`, { method: "POST", json: { action: "delete" } }).catch((e) => toast(e.message, "error"));
					loadReminders();
				}),
			);
			list.append(item);
		}
	} catch (err) {
		list.innerHTML = "";
		toast(err.message, "error");
	}
}

// ───────────────────────────── tareas programadas ─────────────────────────────

const DELIVER = { both: "web y Telegram", web: "web", telegram: "Telegram" };
const ACTION = { agent: "Aku lo hace", notify: "mensaje", reminder: "mensaje", exec: "comando" };

function shortDate(iso) {
	return iso ? new Date(iso).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" }) : "";
}

async function cronAction(id, action) {
	try {
		await api(`/api/cron/${encodeURIComponent(id)}`, { method: "POST", json: { action } });
		if (action === "run") toast("Ejecutando la tarea: el resultado te llegará como aviso.");
	} catch (err) {
		toast(err.message, "error");
	}
	loadCronTasks();
}

export async function loadCronTasks() {
	const list = $("#cron-list");
	try {
		const { tasks = [] } = await api("/api/cron");
		if (!tasks.length) {
			list.innerHTML = '<div class="sb-empty">No tienes tareas programadas.</div>';
			return;
		}
		list.innerHTML = "";
		for (const t of tasks) {
			const item = el("div", `rem-item${t.enabled ? "" : " done"}`, `${icon("zap")}<div class="info"><strong></strong><span class="rem-what"></span><span class="rem-when"></span></div>`);
			$("strong", item).textContent = t.name;
			$(".rem-what", item).textContent = `${ACTION[t.action] || t.action}: ${t.what}`;
			$(".rem-what", item).title = t.what;
			const state = t.running ? "ejecutándose ahora" : t.enabled ? `próxima: ${shortDate(t.nextRun)}` : "en pausa";
			$(".rem-when", item).textContent = `${t.schedule} · llega por ${DELIVER[t.deliver] || t.deliver} · ${state}`;
			if (t.lastError) {
				const err = el("span", "rem-error");
				err.textContent = `Último error: ${t.lastError}`;
				$(".info", item).append(err);
			}
			if (!t.running) item.append(actionButton("zap", "Ejecutar ahora", () => cronAction(t.id, "run")));
			item.append(
				t.enabled
					? actionButton("pause", "Pausar", () => cronAction(t.id, "pause"))
					: actionButton("refresh", "Reanudar", () => cronAction(t.id, "resume")),
				actionButton("trash", "Eliminar", () => {
					if (!confirm(`¿Eliminar la tarea «${t.name}»?`)) return;
					cronAction(t.id, "delete");
				}),
			);
			list.append(item);
		}
	} catch (err) {
		list.innerHTML = "";
		toast(err.message, "error");
	}
}

export async function pollNotifications() {
	try {
		const { notifications = [] } = await api("/api/notifications");
		for (const n of notifications) {
			if (n.kind === "update") {
				toast(`${n.title}. ${n.description || ""}`, "bell", 15000);
				notifySystem(n.title, n.description || "");
				continue;
			}
			const task = n.kind === "task";
			const label = task ? "Tarea lista" : "Recordatorio";
			toast(`${label}: ${n.title}`, "bell", 12000);
			const body = (n.description || "").slice(0, 240);
			notifySystem(`⏰ ${n.title}`, body || `${label} de Aku`);
			if (voice.active || prefs.autoRead) {
				const sp = voice.speaker || new Speaker(ttsSettings);
				sp.speak(`${label}: ${n.title}`);
			}
		}
		if (notifications.some((n) => n.kind === "task") && remDlg.open) loadCronTasks();
	} catch {}
}

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initReminders() {
	$("#rem-form").onsubmit = async (e) => {
		e.preventDefault();
		const when = new Date($("#rem-when").value);
		if (Number.isNaN(when.getTime())) return toast("Fecha no válida.", "error");
		try {
			await api("/api/reminders", {
				method: "POST",
				json: { title: $("#rem-title").value.trim(), datetime: when.toISOString(), repeat: $("#rem-repeat").value },
			});
			$("#rem-title").value = "";
			toast("Recordatorio creado");
			loadReminders();
		} catch (err) {
			toast(err.message, "error");
		}
	};
}
