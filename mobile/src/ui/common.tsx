import type { ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { Theme } from "../theme";

export function Header({ theme, title, left, right }: { theme: Theme; title: string; left?: ReactNode; right?: ReactNode }) {
	return (
		<View style={[styles.header, { borderColor: theme.border, backgroundColor: theme.bg }]}>
			<View style={styles.side}>{left}</View>
			<Text numberOfLines={1} style={[styles.title, { color: theme.text }]}>{title}</Text>
			<View style={[styles.side, { alignItems: "flex-end" }]}>{right}</View>
		</View>
	);
}

export function IconButton({ theme, label, onPress, accessibilityLabel }: { theme: Theme; label: string; onPress: () => void; accessibilityLabel: string }) {
	return (
		<Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} hitSlop={8} style={({ pressed }) => [styles.icon, pressed && { backgroundColor: theme.soft }]}>
			<Text style={{ color: theme.text, fontSize: 22 }}>{label}</Text>
		</Pressable>
	);
}

export function Button({
	theme,
	title,
	onPress,
	busy,
	kind = "primary",
	style,
}: {
	theme: Theme;
	title: string;
	onPress: () => void;
	busy?: boolean;
	kind?: "primary" | "secondary" | "danger";
	style?: StyleProp<ViewStyle>;
}) {
	const bg = kind === "primary" ? theme.btn : "transparent";
	const fg = kind === "primary" ? theme.btnText : kind === "danger" ? theme.danger : theme.text;
	return (
		<Pressable
			onPress={busy ? undefined : onPress}
			accessibilityRole="button"
			style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: kind === "primary" ? bg : theme.border, opacity: pressed || busy ? 0.7 : 1 }, style]}
		>
			{busy ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{title}</Text>}
		</Pressable>
	);
}

/** Pregunta Sí/No (en el navegador, Alert de React Native no hace nada: se usa confirm). */
export function confirm(title: string, message: string, ok: string): Promise<boolean> {
	if (Platform.OS === "web") return Promise.resolve(globalThis.confirm?.(`${title}\n\n${message}`) ?? false);
	return new Promise((resolve) =>
		Alert.alert(title, message, [
			{ text: "Cancelar", style: "cancel", onPress: () => resolve(false) },
			{ text: ok, style: "destructive", onPress: () => resolve(true) },
		]),
	);
}

const styles = StyleSheet.create({
	header: { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
	side: { width: 88, flexDirection: "row", gap: 4 },
	title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "600" },
	icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
	button: { height: 46, borderRadius: 23, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
});
