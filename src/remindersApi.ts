/**
 * Recordatorios (`/api/reminders*`) y los avisos que la web recoge cuando vence uno (`/api/notifications`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { startHeartbeat, setNotificationCallback } from "./core/reminders/notifications.js";
import { readBody, sendJson } from "./http.js";

const pendingNotifications: Array<{ id: string; title: string; description?: string; datetime: string; createdAt: string }> = [];

/** Empieza a revisar los recordatorios; los que vencen quedan para /api/notifications. */
export function startReminderNotifications(): void {
	setNotificationCallback((reminder) => {
		pendingNotifications.unshift({
			id: reminder.id,
			title: reminder.title,
			description: reminder.description,
			datetime: reminder.datetime,
			createdAt: reminder.createdAt,
		});
		if (pendingNotifications.length > 50) pendingNotifications.length = 50;
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

	if (method === "GET" && pathname === "/api/notifications") {
		const notifs = pendingNotifications.splice(0, 10);
		sendJson(res, 200, { notifications: notifs });
		return true;
	}
	return false;
}
