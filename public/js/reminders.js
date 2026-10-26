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
	await loadReminders();
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

export async function pollNotifications() {
	try {
		const { notifications = [] } = await api("/api/notifications");
		for (const n of notifications) {
			toast(`Recordatorio: ${n.title}`, "bell", 12000);
			notifySystem(`⏰ ${n.title}`, n.description || "Recordatorio de Shiro");
			if (voice.active || prefs.autoRead) {
				const sp = voice.speaker || new Speaker(ttsSettings);
				sp.speak(`Recordatorio: ${n.title}`);
			}
		}
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
