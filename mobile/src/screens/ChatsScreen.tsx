import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { deleteChat, listChats, type SupabaseConn } from "../core/supabase";
import type { ChatMeta } from "../core/types";
import type { Theme } from "../theme";
import { Button, Header, IconButton, confirm } from "../ui/common";

type Props = { theme: Theme; sb: SupabaseConn; title: string; onOpen: (chat: ChatMeta | null) => void; onSettings: () => void };

function when(ts: number): string {
	const d = new Date(ts);
	const today = new Date();
	if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
	return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

export function ChatsScreen({ theme, sb, title, onOpen, onSettings }: Props) {
	const [chats, setChats] = useState<ChatMeta[] | null>(null);
	const [error, setError] = useState("");
	const [refreshing, setRefreshing] = useState(false);

	const load = useCallback(async () => {
		try {
			setChats(await listChats(sb));
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [sb]);

	useEffect(() => {
		void load();
	}, [load]);

	async function remove(chat: ChatMeta) {
		if (!(await confirm("Borrar chat", `«${chat.title}» se borra también en el PC.`, "Borrar"))) return;
		try {
			await deleteChat(sb, chat.id);
			setChats((prev) => prev?.filter((c) => c.id !== chat.id) ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<View style={{ flex: 1 }}>
			<Header
				theme={theme}
				title={title}
				left={<IconButton theme={theme} label="⚙" accessibilityLabel="Ajustes" onPress={onSettings} />}
				right={<IconButton theme={theme} label="✎" accessibilityLabel="Chat nuevo" onPress={() => onOpen(null)} />}
			/>
			{error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
			<FlatList
				data={chats ?? []}
				keyExtractor={(c) => c.id}
				refreshControl={
					<RefreshControl
						refreshing={refreshing}
						onRefresh={async () => {
							setRefreshing(true);
							await load();
							setRefreshing(false);
						}}
					/>
				}
				ListEmptyComponent={
					chats ? (
						<View style={styles.empty}>
							<Text style={[styles.emptyText, { color: theme.muted }]}>Aún no hay chats. Los del PC también salen aquí.</Text>
							<Button theme={theme} title="Empezar a hablar" onPress={() => onOpen(null)} />
						</View>
					) : (
						<Text style={[styles.emptyText, { color: theme.muted, marginTop: 40 }]}>Cargando…</Text>
					)
				}
				renderItem={({ item }) => (
					<Pressable
						onPress={() => onOpen(item)}
						onLongPress={() => remove(item)}
						style={({ pressed }) => [styles.row, { borderColor: theme.border, backgroundColor: pressed ? theme.soft : "transparent" }]}
					>
						<View style={{ flex: 1, gap: 2 }}>
							<Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>{item.title}</Text>
							{item.lastPreview ? <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 14 }}>{item.lastPreview}</Text> : null}
						</View>
						<Text style={{ color: theme.muted, fontSize: 12 }}>{when(item.updatedAt)}</Text>
					</Pressable>
				)}
			/>
			{chats?.length ? <Text style={[styles.hint, { color: theme.muted }]}>Mantén pulsado un chat para borrarlo.</Text> : null}
		</View>
	);
}

const styles = StyleSheet.create({
	row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
	rowTitle: { fontSize: 16, fontWeight: "500" },
	empty: { alignItems: "center", gap: 16, padding: 32, marginTop: 40 },
	emptyText: { fontSize: 15, textAlign: "center" },
	error: { padding: 12, fontSize: 14 },
	hint: { textAlign: "center", fontSize: 12, padding: 8 },
});
