import { getDueReminders, completeReminder, type Reminder } from "./reminders.js";

export type NotificationCallback = (reminder: Reminder) => void | Promise<void>;

let notificationCallback: NotificationCallback | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const NOTIFICATION_CHECK_MS = 5000;

export function setNotificationCallback(callback: NotificationCallback): void {
	notificationCallback = callback;
}

/** Último error al leer los recordatorios: se muestra una vez, no cada 5 s. */
let lastError = "";

export async function checkAndNotifyDueReminders(): Promise<void> {
	let due: Reminder[];
	try {
		due = await getDueReminders();
		if (lastError) console.log("🔔 Recordatorios: se recuperó el acceso a los recordatorios.");
		lastError = "";
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message !== lastError) console.error(`🔔 No pude leer los recordatorios: ${message}`);
		lastError = message;
		return;
	}
	for (const reminder of due) {
		if (notificationCallback) {
			try {
				await notificationCallback(reminder);
			} catch (err) {
				console.error("Error en callback de notificación:", err);
			}
		}
		
		await completeReminder(reminder.id);
		
		console.log(`🔔 Recordatorio: ${reminder.title}`);
	}
}

export function startHeartbeat(): void {
	if (heartbeatInterval) return;
	
	checkAndNotifyDueReminders().catch((err) => console.error("Error en heartbeat de recordatorios:", err));
	
	heartbeatInterval = setInterval(() => {
		checkAndNotifyDueReminders().catch((err) => {
			console.error("Error en heartbeat de recordatorios:", err);
		});
	}, NOTIFICATION_CHECK_MS);
	
	console.log("💓 Heartbeat de recordatorios iniciado (cada 5s)");
}

