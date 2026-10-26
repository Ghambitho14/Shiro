/**
 * Barra lateral de la web en el móvil: se desliza desde la izquierda con el fondo oscurecido.
 * Marca, «Nuevo chat», «Buscar chats», chats por fecha (como groupLabel de public/js/sidebar.js) y el pie con Ajustes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import type { ChatMeta } from "../core/types";
import { radius, type Theme } from "../theme";
import { IconButton, Initials } from "./common";
import { Icon, type IconName } from "./Icon";

const AVATAR = require("../../assets/avatar.png");

/** Mismos grupos que la web: Hoy, Ayer, Últimos 7 días, Últimos 30 días, «Octubre de 2026». */
export function groupLabel(ts: number, now = new Date()): string {
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diff = Math.round((day(now) - day(new Date(ts))) / 86_400_000);
	if (diff <= 0) return "Hoy";
	if (diff === 1) return "Ayer";
	if (diff < 7) return "Últimos 7 días";
	if (diff < 30) return "Últimos 30 días";
	const s = new Date(ts).toLocaleDateString("es", { month: "long", year: "numeric" });
	return s.charAt(0).toUpperCase() + s.slice(1);
}

const norm = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

type Props = {
	theme: Theme;
	open: boolean;
	onClose: () => void;
	assistantName: string;
	userName: string;
	chats: ChatMeta[];
	activeId: string | null;
	onNew: () => void;
	onOpen: (chat: ChatMeta) => void;
	onDelete: (chat: ChatMeta) => void;
	onSettings: () => void;
};

export function Sidebar({ theme, open, onClose, assistantName, userName, chats, activeId, onNew, onOpen, onDelete, onSettings }: Props) {
	const { width } = useWindowDimensions();
	const w = Math.min(304, Math.round(width * 0.84));
	const x = useRef(new Animated.Value(open ? 0 : -w)).current;
	const [visible, setVisible] = useState(open);
	const [searching, setSearching] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => {
		if (open) setVisible(true);
		Animated.timing(x, { toValue: open ? 0 : -w, duration: 220, useNativeDriver: true }).start(() => {
			if (!open) setVisible(false);
		});
	}, [open, w, x]);

	const groups = useMemo(() => {
		const q = norm(query.trim());
		const out: { label: string; items: ChatMeta[] }[] = [];
		for (const c of chats) {
			if (q && !norm(`${c.title} ${c.lastPreview}`).includes(q)) continue;
			const label = groupLabel(c.updatedAt);
			const last = out[out.length - 1];
			if (last?.label === label) last.items.push(c);
			else out.push({ label, items: [c] });
		}
		return out;
	}, [chats, query]);

	if (!visible) return null;
	const backdrop = x.interpolate({ inputRange: [-w, 0], outputRange: [0, 1] });

	const item = (icon: IconName, label: string, onPress: () => void) => (
		<Pressable onPress={onPress} style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.hover }]}>
			<Icon name={icon} size={18} color={theme.text2} />
			<Text style={[styles.itemText, { color: theme.text }]}>{label}</Text>
		</Pressable>
	);

	return (
		<View style={StyleSheet.absoluteFill} pointerEvents="box-none">
			<Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay, opacity: backdrop }]}>
				<Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Cerrar barra lateral" />
			</Animated.View>
			<Animated.View style={[styles.panel, { width: w, backgroundColor: theme.sidebar, transform: [{ translateX: x }] }]}>
				<View style={styles.top}>
					<View style={styles.brand}>
						<Image source={AVATAR} style={styles.brandImg} />
						<Text style={[styles.brandText, { color: theme.text }]} numberOfLines={1}>
							{assistantName}
						</Text>
					</View>
					<IconButton theme={theme} icon="panel" label="Cerrar barra lateral" onPress={onClose} />
				</View>
				<View style={styles.nav}>
					{item("edit", "Nuevo chat", onNew)}
					{item("search", "Buscar chats", () => {
						setSearching((s) => !s);
						setQuery("");
					})}
				</View>
				{searching ? (
					<View style={[styles.search, { backgroundColor: theme.hover }]}>
						<Icon name="search" size={16} color={theme.text3} />
						<TextInput
							autoFocus
							value={query}
							onChangeText={setQuery}
							placeholder="Buscar en tus chats"
							placeholderTextColor={theme.text3}
							style={[styles.searchInput, { color: theme.text }]}
						/>
					</View>
				) : null}
				<ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12 }}>
					{groups.map((g) => (
						<View key={g.label}>
							<Text style={[styles.group, { color: theme.text3 }]}>{g.label}</Text>
							{g.items.map((c) => (
								<Pressable
									key={c.id}
									onPress={() => onOpen(c)}
									onLongPress={() => onDelete(c)}
									style={({ pressed }) => [styles.chat, (pressed || c.id === activeId) && { backgroundColor: c.id === activeId ? theme.active : theme.hover }]}
								>
									<Text numberOfLines={1} style={[styles.chatText, { color: theme.text }]}>
										{c.title}
									</Text>
								</Pressable>
							))}
						</View>
					))}
					{!groups.length ? <Text style={[styles.empty, { color: theme.text3 }]}>{query ? "Nada coincide con la búsqueda." : "Aún no hay chats."}</Text> : null}
				</ScrollView>
				<View style={[styles.footer, { borderColor: theme.border }]}>
					<Pressable onPress={onSettings} style={({ pressed }) => [styles.user, pressed && { backgroundColor: theme.hover }]} accessibilityLabel="Abrir ajustes">
						<Initials name={userName || "Tú"} />
						<View style={{ flex: 1 }}>
							<Text numberOfLines={1} style={{ color: theme.text, fontWeight: "600", fontSize: 14 }}>
								{userName || "Tú"}
							</Text>
							<Text style={{ color: theme.text3, fontSize: 12.5 }}>Ajustes</Text>
						</View>
						<Icon name="settings" size={18} color={theme.text2} />
					</Pressable>
				</View>
			</Animated.View>
		</View>
	);
}

const styles = StyleSheet.create({
	panel: { position: "absolute", top: 0, bottom: 0, left: 0, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 24, elevation: 16 },
	top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 8, paddingLeft: 12 },
	brand: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
	brandImg: { width: 28, height: 28, borderRadius: 8 },
	brandText: { fontSize: 16, fontWeight: "600" },
	nav: { paddingHorizontal: 8, paddingBottom: 6 },
	item: { flexDirection: "row", alignItems: "center", gap: 10, height: 42, paddingHorizontal: 10, borderRadius: radius.sm },
	itemText: { fontSize: 15 },
	search: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 8, marginBottom: 6, paddingHorizontal: 10, borderRadius: radius.sm, height: 40 },
	searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
	group: { fontSize: 12, fontWeight: "600", paddingTop: 14, paddingBottom: 6, paddingHorizontal: 10 },
	chat: { height: 40, justifyContent: "center", paddingHorizontal: 10, borderRadius: radius.sm },
	chatText: { fontSize: 15 },
	empty: { fontSize: 14, padding: 12 },
	footer: { padding: 8, borderTopWidth: StyleSheet.hairlineWidth },
	user: { flexDirection: "row", alignItems: "center", gap: 10, padding: 8, borderRadius: radius.sm },
});
