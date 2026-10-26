import { useColorScheme } from "react-native";

/** Los colores de la web de Shiro (claro y oscuro). */
const light = {
	bg: "#ffffff",
	soft: "#f3f3f3",
	elevated: "#ffffff",
	border: "rgba(0,0,0,0.1)",
	text: "#0d0d0d",
	muted: "#6b6b6b",
	accent: "#6b5cf6",
	accentSoft: "rgba(107,92,246,0.12)",
	userBubble: "#f3f3f3",
	danger: "#d92d20",
	code: "#f7f7f8",
	btn: "#0d0d0d",
	btnText: "#ffffff",
};

const dark: typeof light = {
	bg: "#212121",
	soft: "#2f2f2f",
	elevated: "#2a2a2a",
	border: "rgba(255,255,255,0.12)",
	text: "#ececec",
	muted: "#a0a0a0",
	accent: "#8b7ff9",
	accentSoft: "rgba(139,127,249,0.18)",
	userBubble: "#303030",
	danger: "#f97066",
	code: "#171717",
	btn: "#ececec",
	btnText: "#0d0d0d",
};

export type Theme = typeof light;

export function useTheme(): Theme {
	return useColorScheme() === "dark" ? dark : light;
}

export const mono = "monospace";
