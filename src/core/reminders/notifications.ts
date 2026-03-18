import { getDueReminders, completeReminder, getReminders, type Reminder } from "./reminders.js";

export type NotificationCallback = (reminder: Reminder) => void | Promise<void>;

let notificationCallback: NotificationCallback | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const NOTIFICATION_CHECK_MS = 5000;

export function setNotificationCallback(callback: NotificationCallback): void {
	notificationCallback = callback;
}

export async function checkAndNotifyDueReminders(): Promise<void> {
	const due = getDueReminders();
	for (const reminder of due) {
		if (notificationCallback) {
			try {
				await notificationCallback(reminder);
			} catch (err) {
				console.error("Error en callback de notificación:", err);
			}
		}
		
		completeReminder(reminder.id);
		
		console.log(`🔔 Recordatorio: ${reminder.title}`);
	}
}

export function startHeartbeat(): void {
	if (heartbeatInterval) return;
	
	checkAndNotifyDueReminders();
	
	heartbeatInterval = setInterval(() => {
		checkAndNotifyDueReminders().catch((err) => {
			console.error("Error en heartbeat de recordatorios:", err);
		});
	}, NOTIFICATION_CHECK_MS);
	
	console.log("💓 Heartbeat de recordatorios iniciado (cada 5s)");
}

export function stopHeartbeat(): void {
	if (heartbeatInterval) {
		clearInterval(heartbeatInterval);
		heartbeatInterval = null;
		console.log("⏹ Heartbeat de recordatorios detenido");
	}
}

export function getHeartbeatStatus(): { running: boolean; nextCheck: number } {
	return {
		running: heartbeatInterval !== null,
		nextCheck: NOTIFICATION_CHECK_MS,
	};
}
