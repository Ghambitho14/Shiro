/**
 * Los colores de la web de Shiro (public/css/app.css), claro y oscuro. Si cambian allí, cambiarlos aquí.
 */
export type ThemePref = "system" | "light" | "dark";

const light = {
	dark: false,
	bg: "#ffffff",
	sidebar: "#f9f9f9",
	elevated: "#ffffff",
	hover: "rgba(0,0,0,0.05)",
	active: "rgba(0,0,0,0.08)",
	soft: "#f3f3f3",
	composer: "#ffffff",
	border: "rgba(0,0,0,0.1)",
	borderStrong: "rgba(0,0,0,0.18)",
	text: "#0d0d0d",
	text2: "#5d5d5d",
	text3: "#8f8f8f",
	accent: "#6b5cf6",
	accentSoft: "rgba(107,92,246,0.12)",
	btn: "#0d0d0d",
	btnText: "#ffffff",
	danger: "#d92d20",
	dangerSoft: "rgba(217,45,32,0.08)",
	success: "#0e9f6e",
	code: "#f7f7f8",
	codeHead: "#ececf1",
	overlay: "rgba(0,0,0,0.4)",
};

const dark: typeof light = {
	dark: true,
	bg: "#212121",
	sidebar: "#171717",
	elevated: "#2b2b2b",
	hover: "rgba(255,255,255,0.06)",
	active: "rgba(255,255,255,0.1)",
	soft: "#303030",
	composer: "#303030",
	border: "rgba(255,255,255,0.1)",
	borderStrong: "rgba(255,255,255,0.18)",
	text: "#ececec",
	text2: "#b4b4b4",
	text3: "#8a8a8a",
	accent: "#8b7dff",
	accentSoft: "rgba(139,125,255,0.16)",
	btn: "#ececec",
	btnText: "#0d0d0d",
	danger: "#f97066",
	dangerSoft: "rgba(249,112,102,0.1)",
	success: "#3ccb8f",
	code: "#171717",
	codeHead: "#2a2a2a",
	overlay: "rgba(0,0,0,0.6)",
};

export type Theme = typeof light;

export function themeFor(pref: ThemePref, system: "light" | "dark" | null | undefined): Theme {
	const isDark = pref === "dark" || (pref === "system" && system === "dark");
	return isDark ? dark : light;
}

/** Radios de la web (--radius-sm, --radius, --radius-lg, --radius-xl). */
export const radius = { sm: 8, md: 12, lg: 18, xl: 28 };

export const mono = "monospace";
