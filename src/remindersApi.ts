/**
 * Recordatorios (`/api/reminders*`), tareas programadas (`/api/cron*`) y los avisos que la web recoge
 * cuando vence un recordatorio o termina una tarea (`/api/notifications`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { startHeartbeat, setNotificationCallback, pushWebNotice, takeWebNotices } from "./core/reminders/notifications.js";
import { readBody, sendJson } from "./http.js";

/** Empieza a revisar los recordatorios; los que vencen quedan para /api/notifications. */
export function startReminderNotifications(): void {
	setNotificationCallback((reminder) => {
		pushWebNotice({
			id: reminder.id,
			title: reminder.title,
			description: reminder.description,
			datetime: reminder.datetime,
			createdAt: reminder.createdAt,
			kind: "reminder",
		});
	});
	startHeartbeat();
}

export async function handleRemindersApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
	if (method === "GET" && pathname === "/api/reminders") {
		const { getReminders } = await import("./core/reminders/reminders.js");
		sendJson(res, 200, { reminders: await getReminders() });
		return true;
	}

	if (method === "POST" && pathname === "/api/reminders") {
		let body = "";
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return true;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		const { createReminder } = await import("./core/reminders/reminders.js");
		try {
			const reminder = await createReminder({
				title: String(payload.title || ""),
				datetime: String(payload.datetime || ""),
				description: payload.description ? String(payload.description) : undefined,
				repeat: payload.repeat ? String(payload.repeat) as "daily" | "weekly" | "monthly" | "none" : "none",
			});
			sendJson(res, 201, { reminder });
		} catch (err) {
			sendJson(res, 500, { error: err instanceof Error ? err.message : "Error creating reminder" });
		}
		return true;
	}

	if (method === "POST" && pathname.startsWith("/api/reminders/")) {
		const id = pathname.slice("/api/reminders/".length);
		let body = "";
		try {
			body = await readBody(req);
		} catch {
			sendJson(res, 400, { error: "Invalid body" });
			return true;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		if (payload.action === "complete") {
			const { completeReminder } = await import("./core/reminders/reminders.js");
			const result = await completeReminder(id);
			if (result) {
				sendJson(res, 200, { success: true, reminder: result });
			} else {
				sendJson(res, 404, { error: "Reminder not found" });
			}
			return true;
		}
		if (payload.action === "delete") {
			const { deleteReminder } = await import("./core/reminders/reminders.js");
			const result = await deleteReminder(id);
			sendJson(res, 200, { success: result });
			return true;
		}
		sendJson(res, 400, { error: "Invalid action" });
		return true;
	}

	// ── Tareas programadas (se crean desde el chat; aquí se ven, pausan, borran o ejecutan ya) ──
	if (method === "GET" && pathname === "/api/cron") {
		const { listCronTasks, describeTaskSchedule, isCronTaskRunning } = await import("./core/scheduler/CronService.js");
		const tasks = listCronTasks().map((t) => ({
			id: t.id,
			name: t.name,
			action: t.action,
			// Lo que hace, sin el comando entero: basta para reconocerla.
			what: String(t.action === "agent" ? (t.payload.prompt ?? "") : t.action === "exec" ? (t.payload.command ?? "") : (t.payload.message ?? "")).slice(0, 300),
			schedule: describeTaskSchedule(t),
			deliver: t.deliver ?? "both",
			enabled: t.enabled,
			running: isCronTaskRunning(t.id),
			nextRun: t.nextRun,
			lastRun: t.lastRun,
			lastError: t.lastError,
		}));
		sendJson(res, 200, { tasks });
		return true;
	}

	if (method === "POST" && pathname.startsWith("/api/cron/")) {
		const id = decodeURIComponent(pathname.slice("/api/cron/".length));
		let action = "";
		try {
			action = String((JSON.parse((await readBody(req)) || "{}") as { action?: unknown }).action ?? "");
		} catch {
			sendJson(res, 400, { error: "Petición no válida." });
			return true;
		}
		const cron = await import("./core/scheduler/CronService.js");
		if (!cron.getCronTask(id)) {
			sendJson(res, 404, { error: "No encontré esa tarea." });
			return true;
		}
		if (action === "run") {
			if (cron.isCronTaskRunning(id)) {
				sendJson(res, 409, { error: "Esa tarea ya se está ejecutando." });
				return true;
			}
			// Puede tardar minutos: se lanza y el resultado llega como aviso.
			void cron.runCronTask(id).catch((err) => console.error("[Tareas]", err instanceof Error ? err.message : err));
			sendJson(res, 202, { ok: true });
			return true;
		}
		if (action === "pause" || action === "resume") {
			cron.toggleCronTask(id, action === "resume");
			sendJson(res, 200, { ok: true });
			return true;
		}
		if (action === "delete") {
			cron.deleteCronTask(id);
			sendJson(res, 200, { ok: true });
			return true;
		}
		sendJson(res, 400, { error: "Acción no válida." });
		return true;
	}

	if (method === "GET" && pathname === "/api/notifications") {
		const notifs = takeWebNotices(10);
		sendJson(res, 200, { notifications: notifs });
		return true;
	}
	return false;
}
