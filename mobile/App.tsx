import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, BackHandler, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { assistantNameFrom } from "./src/core/prompt";
import { getNotes } from "./src/core/supabase";
import type { AppSettings, ChatMeta } from "./src/core/types";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ChatsScreen } from "./src/screens/ChatsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { isConfigured, loadSettings } from "./src/settings";
import { useTheme } from "./src/theme";

type Screen = { name: "chats" } | { name: "chat"; chat: ChatMeta | null } | { name: "settings" };

export default function App() {
	const theme = useTheme();
	const [settings, setSettings] = useState<AppSettings | null>(null);
	const [screen, setScreen] = useState<Screen>({ name: "chats" });
	const [name, setName] = useState("Shiro");

	useEffect(() => {
		void loadSettings().then(setSettings);
	}, []);

	const sb = useMemo(() => (settings ? { url: settings.supabaseUrl, key: settings.supabaseKey } : null), [settings]);

	// El nombre del asistente: el de Ajustes o el que tiene Shiro en el PC.
	useEffect(() => {
		if (!sb || !settings || !isConfigured(settings)) return;
		getNotes(sb)
			.then((notes) => setName(assistantNameFrom(notes, settings.assistantName)))
			.catch(() => setName(settings.assistantName || "Shiro"));
	}, [sb, settings]);

	// Botón «atrás» de Android: vuelve a la lista en vez de cerrar la app.
	useEffect(() => {
		const sub = BackHandler.addEventListener("hardwareBackPress", () => {
			if (screen.name === "chats" || !settings || !isConfigured(settings)) return false;
			setScreen({ name: "chats" });
			return true;
		});
		return () => sub.remove();
	}, [screen, settings]);

	let body;
	if (!settings) body = <ActivityIndicator style={{ marginTop: 80 }} color={theme.muted} />;
	else if (!isConfigured(settings) || screen.name === "settings") {
		const firstRun = !isConfigured(settings);
		body = (
			<SettingsScreen
				theme={theme}
				initial={settings}
				firstRun={firstRun}
				onBack={firstRun ? undefined : () => setScreen({ name: "chats" })}
				onSaved={(s) => {
					setSettings(s);
					setScreen({ name: "chats" });
				}}
			/>
		);
	} else if (screen.name === "chat" && sb) {
		body = <ChatScreen theme={theme} sb={sb} settings={settings} chat={screen.chat} onBack={() => setScreen({ name: "chats" })} />;
	} else if (sb) {
		body = <ChatsScreen theme={theme} sb={sb} title={name} onOpen={(chat) => setScreen({ name: "chat", chat })} onSettings={() => setScreen({ name: "settings" })} />;
	}

	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }} edges={["top", "bottom", "left", "right"]}>
				<StatusBar style="auto" />
				<View style={{ flex: 1 }}>{body}</View>
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
