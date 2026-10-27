import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, useColorScheme, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { assistantNameFrom, profileBlock } from "./src/core/prompt";
import { listReminders } from "./src/core/reminders";
import { getNotes } from "./src/core/supabase";
import { syncReminderNotifications } from "./src/notifications";
import { PersonalizationScreen } from "./src/screens/PersonalizationScreen";
import { RemindersScreen } from "./src/screens/RemindersScreen";
import type { AppSettings } from "./src/core/types";
import { MainScreen } from "./src/screens/MainScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { isConfigured, loadSettings, saveSettings } from "./src/settings";
import { themeFor } from "./src/theme";

export default function App() {
	const system = useColorScheme();
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [page, setPage] = useState<"main" | "settings" | "reminders" | "personalization">("main");
	const [notesVersion, setNotesVersion] = useState(0);
	const [names, setNames] = useState({ assistant: "Shiro", user: "" });
	const back = useRef<(() => boolean) | null>(null);
	const theme = themeFor(settings?.theme ?? "system", system);

	useEffect(() => {
		void loadSettings().then(setSettings);
	}, []);

	const sb = useMemo(() => (settings ? { url: settings.supabaseUrl, key: settings.supabaseKey } : null), [settings?.supabaseUrl, settings?.supabaseKey]);

	// Nombres del asistente y del usuario: los de Shiro en el PC (notas de Supabase).
	useEffect(() => {
		if (!sb || !settings || !isConfigured(settings)) return;
		getNotes(sb)
			.then((notes) => setNames({ assistant: assistantNameFrom(notes, settings.assistantName), user: profileBlock(notes["Sobre mí.md"]).userName }))
			.catch(() => setNames((n) => ({ ...n, assistant: settings.assistantName || n.assistant })));
	}, [sb, settings?.assistantName, notesVersion]);

	// Al abrir la app: los recordatorios (también los creados en el PC) quedan programados como avisos.
	useEffect(() => {
		if (!sb || !settings || !isConfigured(settings)) return;
		listReminders(sb)
			.then(syncReminderNotifications)
			.catch(() => {});
	}, [sb]);

	const changeSettings = useCallback(
		(patch: Partial<AppSettings>) => {
			if (!settings) return;
			const next = { ...settings, ...patch };
			setSettings(next);
			void saveSettings(next);
		},
		[settings],
	);

	const registerBack = useCallback((fn: (() => boolean) | null) => {
		back.current = fn;
	}, []);

	// Botón «atrás» de Android: cierra la barra lateral o vuelve de Ajustes antes de salir de la app.
	useEffect(() => {
		const sub = BackHandler.addEventListener("hardwareBackPress", () => {
			if (page !== "main" && settings && isConfigured(settings)) {
				setPage(page === "personalization" ? "settings" : "main");
				return true;
			}
			return back.current?.() ?? false;
		});
		return () => sub.remove();
	}, [page, settings]);

	const configured = Boolean(settings && isConfigured(settings));
	// El chat se queda montado debajo de Ajustes y Recordatorios: al volver sigue igual.
	let overlay = null;
	if (settings && (!configured || page === "settings")) {
		overlay = (
			<SettingsScreen
				theme={theme}
				initial={settings}
				firstRun={!configured}
				onBack={configured ? () => setPage("main") : undefined}
				onPersonalization={configured ? () => setPage("personalization") : undefined}
				onSaved={(s) => {
					setSettings(s);
					setPage("main");
				}}
			/>
		);
	} else if (sb && page === "reminders") {
		overlay = <RemindersScreen theme={theme} sb={sb} onBack={() => setPage("main")} />;
	} else if (sb && page === "personalization") {
		overlay = <PersonalizationScreen theme={theme} sb={sb} onBack={() => setPage("settings")} onSaved={() => setNotesVersion((v) => v + 1)} />;
	}

	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }} edges={["top", "bottom", "left", "right"]}>
				<StatusBar style={theme.dark ? "light" : "dark"} />
				<View style={{ flex: 1 }}>
					{!settings ? <ActivityIndicator style={{ marginTop: 80 }} color={theme.text3} /> : null}
					{settings && configured && sb ? (
						<MainScreen
							theme={theme}
							sb={sb}
							settings={settings}
							assistantName={names.assistant}
							userName={names.user}
							onSettings={() => setPage("settings")}
							onReminders={() => setPage("reminders")}
							onChangeSettings={changeSettings}
							registerBack={registerBack}
						/>
					) : null}
					{overlay ? <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}>{overlay}</View> : null}
				</View>
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
