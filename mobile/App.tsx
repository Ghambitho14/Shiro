import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, useColorScheme, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { assistantNameFrom, profileBlock } from "./src/core/prompt";
import { getNotes } from "./src/core/supabase";
import type { AppSettings } from "./src/core/types";
import { MainScreen } from "./src/screens/MainScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { isConfigured, loadSettings, saveSettings } from "./src/settings";
import { themeFor } from "./src/theme";

export default function App() {
	const system = useColorScheme();
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [showSettings, setShowSettings] = useState(false);
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
	}, [sb, settings?.assistantName]);

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
			if (showSettings && settings && isConfigured(settings)) {
				setShowSettings(false);
				return true;
			}
			return back.current?.() ?? false;
		});
		return () => sub.remove();
	}, [showSettings, settings]);

	let body;
	if (!settings) body = <ActivityIndicator style={{ marginTop: 80 }} color={theme.text3} />;
	else if (!isConfigured(settings) || showSettings) {
		const firstRun = !isConfigured(settings);
		body = (
			<SettingsScreen
				theme={theme}
				initial={settings}
				firstRun={firstRun}
				onBack={firstRun ? undefined : () => setShowSettings(false)}
				onSaved={(s) => {
					setSettings(s);
					setShowSettings(false);
				}}
			/>
		);
	} else if (sb) {
		body = (
			<MainScreen
				theme={theme}
				sb={sb}
				settings={settings}
				assistantName={names.assistant}
				userName={names.user}
				onSettings={() => setShowSettings(true)}
				onChangeSettings={changeSettings}
				registerBack={registerBack}
			/>
		);
	}

	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }} edges={["top", "bottom", "left", "right"]}>
				<StatusBar style={theme.dark ? "light" : "dark"} />
				<View style={{ flex: 1 }}>{body}</View>
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
