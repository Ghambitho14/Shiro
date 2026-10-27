/**
 * Avisos de los recordatorios en el teléfono: cada recordatorio pendiente con fecha futura queda
 * programado como notificación local. Se rehace la lista al abrir la app y cada vez que cambian
 * (los creados en el PC llegan la próxima vez que abras la app).
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { isPending, type Reminder } from "./core/reminders";

const CHANNEL = "recordatorios";
/** Android deja programar un número limitado de alarmas por app. */
const MAX_SCHEDULED = 50;

if (Platform.OS !== "web") {
	Notifications.setNotificationHandler({
		handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
	});
}

let ready: Promise<boolean> | null = null;

/** Pide permiso una vez y crea el canal de Android. false si el usuario no deja avisar. */
function ensureReady(): Promise<boolean> {
	ready ??= (async () => {
		if (Platform.OS === "android") {
			await Notifications.setNotificationChannelAsync(CHANNEL, {
				name: "Recordatorios",
				importance: Notifications.AndroidImportance.HIGH,
				vibrationPattern: [0, 250, 250, 250],
			});
		}
		const current = await Notifications.getPermissionsAsync();
		if (current.granted) return true;
		return (await Notifications.requestPermissionsAsync()).granted;
	})().catch(() => false);
	return ready;
}

export async function syncReminderNotifications(reminders: Reminder[]): Promise<void> {
	if (Platform.OS === "web" || !(await ensureReady())) return;
	await Notifications.cancelAllScheduledNotificationsAsync();
	const now = Date.now();
	const upcoming = reminders
		.filter((r) => isPending(r) && new Date(r.datetime).getTime() > now)
		.sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime())
		.slice(0, MAX_SCHEDULED);
	for (const r of upcoming) {
		await Notifications.scheduleNotificationAsync({
			identifier: r.id,
			content: { title: r.title, body: r.description || "Recordatorio de Shiro", data: { reminderId: r.id } },
			trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(r.datetime), channelId: CHANNEL },
		});
	}
}
