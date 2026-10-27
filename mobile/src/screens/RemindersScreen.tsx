/**
 * Recordatorios (como el panel de la web): pendientes y hechos, marcar como hecho, borrar y crear.
 * Son los mismos del PC (Supabase). Cada cambio vuelve a programar los avisos del teléfono.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { completeReminder, createReminder, deleteReminder, isPending, listReminders, parseWhen, REPEAT_LABELS, type Reminder, type Repeat } from "../core/reminders";
import type { SupabaseConn } from "../core/supabase";
import { syncReminderNotifications } from "../notifications";
import { radius, type Theme } from "../theme";
import { Button, confirm, IconButton } from "../ui/common";
import { Icon } from "../ui/Icon";

type Props = { theme: Theme; sb: SupabaseConn; onBack: () => void };

const fmt = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

const QUICK: { label: string; when: string }[] = [
	{ label: "En 30 min", when: "en 30 minutos" },
	{ label: "En 1 hora", when: "en 1 hora" },
	{ label: "Esta tarde", when: "hoy a las 18:00" },
	{ label: "Mañana 9:00", when: "mañana a las 9" },
];

export function RemindersScreen({ theme, sb, onBack }: Props) {
	const [list, setList] = useState<Reminder[] | null>(null);
	const [error, setError] = useState("");
	const [title, setTitle] = useState("");
	const [when, setWhen] = useState("");
	const [repeat, setRepeat] = useState<Repeat>("none");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const all = await listReminders(sb);
			setList(all);
			setError("");
			void syncReminderNotifications(all).catch(() => {});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [sb]);

	useEffect(() => {
		void load();
	}, [load]);

	async function add() {
		setBusy(true);
		setError("");
		try {
			await createReminder(sb, { title, datetime: when, repeat });
			setTitle("");
			setWhen("");
			setRepeat("none");
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	function pickDate() {
		const base = parseWhen(when) ? new Date(parseWhen(when)!) : new Date(Date.now() + 3_600_000);
		DateTimePickerAndroid.open({
			value: base,
			mode: "date",
			onChange: (e, date) => {
				if (e.type !== "set" || !date) return;
				DateTimePickerAndroid.open({
					value: date,
					mode: "time",
					is24Hour: true,
					onChange: (e2, time) => {
						if (e2.type === "set" && time) setWhen(time.toISOString());
					},
				});
			},
		});
	}

	const pending = (list ?? []).filter(isPending);
	const done = (list ?? []).filter((r) => !isPending(r)).slice(-20).reverse();
	const preview = parseWhen(when);

	const row = (r: Reminder) => (
		<View key={r.id} style={[styles.item, { borderColor: theme.border }]}>
			<Pressable
				accessibilityLabel={isPending(r) ? `Marcar «${r.title}» como hecho` : "Hecho"}
				onPress={async () => {
					if (!isPending(r)) return;
					await completeReminder(sb, r.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
					await load();
				}}
				style={[styles.check, { borderColor: isPending(r) ? theme.borderStrong : theme.success, backgroundColor: isPending(r) ? "transparent" : theme.success }]}
			>
				{!isPending(r) ? <Icon name="check" size={14} color="#fff" strokeWidth={3} /> : null}
			</Pressable>
			<View style={{ flex: 1 }}>
				<Text style={{ color: isPending(r) ? theme.text : theme.text3, fontSize: 15, textDecorationLine: isPending(r) ? "none" : "line-through" }}>{r.title}</Text>
				<Text style={{ color: new Date(r.datetime).getTime() < Date.now() && isPending(r) ? theme.danger : theme.text3, fontSize: 13 }}>
					{fmt(r.datetime)}
					{r.repeat && r.repeat !== "none" ? ` · ${REPEAT_LABELS[r.repeat]}` : ""}
				</Text>
				{r.description ? <Text style={{ color: theme.text2, fontSize: 13 }}>{r.description}</Text> : null}
			</View>
			<IconButton
				theme={theme}
				icon="trash"
				size={18}
				label={`Borrar «${r.title}»`}
				onPress={async () => {
					if (!(await confirm("Borrar recordatorio", `«${r.title}» se borra también en el PC.`, "Borrar"))) return;
					await deleteReminder(sb, r.id).catch((err) => setError(err instanceof Error ? err.message : String(err)));
					await load();
				}}
			/>
		</View>
	);

	return (
		<KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<View style={styles.header}>
				<IconButton theme={theme} icon="arrowLeft" label="Volver" onPress={onBack} />
				<Text style={[styles.title, { color: theme.text }]}>Recordatorios</Text>
			</View>
			<ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
				<View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
					<TextInput
						value={title}
						onChangeText={setTitle}
						placeholder="¿Qué te recuerdo?"
						placeholderTextColor={theme.text3}
						style={[styles.input, { color: theme.text, borderColor: theme.border }]}
					/>
					<View style={styles.whenRow}>
						<TextInput
							value={when}
							onChangeText={setWhen}
							placeholder="Cuándo: mañana a las 9, en 2 horas…"
							placeholderTextColor={theme.text3}
							style={[styles.input, { color: theme.text, borderColor: theme.border, flex: 1 }]}
						/>
						{Platform.OS === "android" ? <IconButton theme={theme} icon="bell" label="Elegir fecha y hora" onPress={pickDate} /> : null}
					</View>
					<View style={styles.chips}>
						{QUICK.map((q) => (
							<Pressable key={q.label} onPress={() => setWhen(q.when)} style={[styles.chip, { borderColor: theme.border }]}>
								<Text style={{ color: theme.text2, fontSize: 13 }}>{q.label}</Text>
							</Pressable>
						))}
					</View>
					<View style={styles.chips}>
						{(Object.keys(REPEAT_LABELS) as Repeat[]).map((k) => (
							<Pressable
								key={k}
								onPress={() => setRepeat(k)}
								style={[styles.chip, { borderColor: repeat === k ? theme.accent : theme.border, backgroundColor: repeat === k ? theme.accentSoft : "transparent" }]}
							>
								<Text style={{ color: repeat === k ? theme.text : theme.text2, fontSize: 13 }}>{REPEAT_LABELS[k]}</Text>
							</Pressable>
						))}
					</View>
					{when.trim() ? (
						<Text style={{ color: preview ? theme.text2 : theme.danger, fontSize: 13 }}>{preview ? `Avisará el ${fmt(preview)}` : "No entiendo esa fecha."}</Text>
					) : null}
					<Button theme={theme} title="Crear recordatorio" icon="plus" busy={busy} onPress={add} style={{ alignSelf: "flex-start" }} />
				</View>

				{error ? <Text style={{ color: theme.danger, fontSize: 14 }}>{error}</Text> : null}
				{!list ? <ActivityIndicator color={theme.text3} style={{ marginTop: 24 }} /> : null}

				{list ? (
					<>
						<Text style={[styles.section, { color: theme.text3 }]}>PENDIENTES</Text>
						{pending.length ? pending.map(row) : <Text style={{ color: theme.text3, fontSize: 14 }}>No tienes recordatorios pendientes.</Text>}
						{done.length ? <Text style={[styles.section, { color: theme.text3 }]}>HECHOS</Text> : null}
						{done.map(row)}
						<Text style={{ color: theme.text3, fontSize: 12.5, marginTop: 12 }}>
							El teléfono te avisa de los pendientes. Los que crees en el PC llegan la próxima vez que abras la app.
						</Text>
					</>
				) : null}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	header: { height: 56, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6 },
	title: { fontSize: 18, fontWeight: "600" },
	body: { padding: 16, gap: 10, paddingBottom: 48 },
	card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: 12, gap: 10 },
	input: { borderWidth: 1, borderRadius: radius.sm + 2, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
	whenRow: { flexDirection: "row", alignItems: "center", gap: 6 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
	chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
	section: { fontSize: 12, fontWeight: "700", letterSpacing: 0.6, marginTop: 14 },
	item: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
	check: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
