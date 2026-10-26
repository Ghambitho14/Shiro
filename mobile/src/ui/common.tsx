import type { ReactNode } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { radius, type Theme } from "../theme";
import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";
import { Icon, type IconName } from "./Icon";

/** Botón de icono de la web (.icon-btn: 36 px, color --text-2). */
export function IconButton({
	theme,
	icon,
	onPress,
	label,
	size = 20,
	color,
}: {
	theme: Theme;
	icon: IconName;
	onPress: () => void;
	label: string;
	size?: number;
	color?: string;
}) {
	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			hitSlop={6}
			style={({ pressed }) => [styles.icon, pressed && { backgroundColor: theme.hover }]}
		>
			<Icon name={icon} size={size} color={color ?? theme.text2} />
		</Pressable>
	);
}

/** Botón de la web (.btn): negro (o blanco en oscuro) o con borde. */
export function Button({
	theme,
	title,
	onPress,
	busy,
	kind = "primary",
	icon,
	style,
}: {
	theme: Theme;
	title: string;
	onPress: () => void;
	busy?: boolean;
	kind?: "primary" | "secondary" | "danger";
	icon?: IconName;
	style?: StyleProp<ViewStyle>;
}) {
	const bg = kind === "primary" ? theme.btn : "transparent";
	const fg = kind === "primary" ? theme.btnText : kind === "danger" ? theme.danger : theme.text;
	return (
		<Pressable
			onPress={busy ? undefined : onPress}
			accessibilityRole="button"
			style={({ pressed }) => [
				styles.button,
				{ backgroundColor: pressed && kind !== "primary" ? theme.hover : bg, borderColor: kind === "primary" ? bg : theme.border, opacity: busy ? 0.7 : 1 },
				style,
			]}
		>
			{busy ? (
				<ActivityIndicator color={fg} />
			) : (
				<View style={styles.buttonRow}>
					{icon ? <Icon name={icon} size={16} color={fg} /> : null}
					<Text style={{ color: fg, fontWeight: "500", fontSize: 14 }}>{title}</Text>
				</View>
			)}
		</Pressable>
	);
}

/** Iniciales sobre el degradado morado de la web (.avatar-initials). */
export function Initials({ name, size = 32 }: { name: string; size?: number }) {
	const letters =
		name
			.trim()
			.split(/\s+/)
			.slice(0, 2)
			.map((w) => w[0]?.toUpperCase() ?? "")
			.join("") || "?";
	return (
		<View style={[styles.initials, { width: size, height: size, borderRadius: size / 2 }]}>
			<Svg width={size} height={size} style={StyleSheet.absoluteFill}>
				<Defs>
					<LinearGradient id="ini" x1="0" y1="0" x2="1" y2="1">
						<Stop offset="0" stopColor="#8b7dff" />
						<Stop offset="1" stopColor="#c084fc" />
					</LinearGradient>
				</Defs>
				<Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#ini)" />
			</Svg>
			<Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>{letters}</Text>
		</View>
	);
}

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	return <View style={[{ flexDirection: "row", alignItems: "center" }, style]}>{children}</View>;
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
	icon: { width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
	button: { minHeight: 40, borderRadius: radius.sm + 2, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
	buttonRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	initials: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
