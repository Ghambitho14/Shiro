import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { runAgentTurn } from "../core/agent";
import { buildSystemPrompt } from "../core/prompt";
import { getChat, getNotes, saveChat, type SupabaseConn } from "../core/supabase";
import { messageText } from "../core/text";
import type { AppSettings, ChatMessage, ChatMeta, FetchFn } from "../core/types";
import type { Theme } from "../theme";
import { Header, IconButton } from "../ui/common";
import { Markdown } from "../ui/Markdown";

/** fetch de Expo: deja leer la respuesta mientras llega (la de React Native no). */
const streamingFetch = expoFetch as unknown as FetchFn;

type Props = { theme: Theme; sb: SupabaseConn; settings: AppSettings; chat: ChatMeta | null; onBack: () => void };

type Draft = { text: string; steps: { label: string; done: boolean; ok?: boolean }[] };

export function ChatScreen({ theme, sb, settings, chat, onBack }: Props) {
	const [meta, setMeta] = useState<ChatMeta | null>(chat);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(Boolean(chat));
	const [input, setInput] = useState("");
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState("");
	const abort = useRef<AbortController | null>(null);
	const list = useRef<FlatList<ChatMessage>>(null);

	// Al abrir, lo último de Supabase (puede que el PC haya escrito algo).
	useEffect(() => {
		if (!chat) return;
		getChat(sb, chat.id)
			.then((full) => {
				if (full) {
					setMessages(full.messages);
					setMeta(full);
				}
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	}, [chat, sb]);

	useEffect(() => () => abort.current?.abort(), []);

	async function send() {
		const text = input.trim();
		if (!text || draft) return;
		setInput("");
		setError("");
		const withUser: ChatMessage[] = [...messages, { role: "user", content: text, ts: Date.now() }];
		setMessages(withUser);
		const current: Draft = { text: "", steps: [] };
		setDraft({ ...current });
		const controller = new AbortController();
		abort.current = controller;
		let saved = meta;
		try {
			saved = await saveChat(sb, meta ?? {}, withUser);
			setMeta(saved);
			const system = buildSystemPrompt(await getNotes(sb), { assistantName: settings.assistantName });
			const result = await runAgentTurn(
				{ sb, ollama: { key: settings.ollamaKey, fetch: streamingFetch }, model: settings.model, system, signal: controller.signal },
				withUser,
				{
					onDelta: (piece) => {
						current.text += piece;
						setDraft({ ...current, steps: [...current.steps] });
					},
					onTool: (label, done, ok) => {
						if (!done) current.steps.push({ label, done });
						else current.steps = current.steps.map((st) => (st.label === label && !st.done ? { label, done, ok } : st));
						setDraft({ ...current, steps: [...current.steps] });
					},
				},
			);
			const answer: ChatMessage = { role: "assistant", content: result.text || "(sin respuesta)", ts: Date.now(), ...(result.tools.length ? { tools: result.tools } : {}) };
			const all = [...withUser, answer];
			setMessages(all);
			setMeta(await saveChat(sb, saved, all));
		} catch (err) {
			if (controller.signal.aborted) {
				// Parado a mano: se guarda lo que alcanzó a escribir.
				if (current.text.trim()) {
					const all: ChatMessage[] = [...withUser, { role: "assistant", content: `${current.text.trim()}\n\n_(detenido)_`, ts: Date.now() }];
					setMessages(all);
					await saveChat(sb, saved ?? {}, all).catch(() => {});
				}
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			abort.current = null;
			setDraft(null);
		}
	}

	const title = meta?.title && meta.title !== "Nueva sesión" ? meta.title : "Chat nuevo";
	const busy = Boolean(draft);

	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Header theme={theme} title={title} left={<IconButton theme={theme} label="‹" accessibilityLabel="Volver" onPress={onBack} />} />
			{loading ? (
				<ActivityIndicator style={{ marginTop: 40 }} color={theme.muted} />
			) : (
				<FlatList
					ref={list}
					data={messages}
					keyExtractor={(_, i) => String(i)}
					contentContainerStyle={styles.list}
					onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
					ListEmptyComponent={<Text style={[styles.empty, { color: theme.muted }]}>¿En qué te ayudo?</Text>}
					renderItem={({ item }) => <Bubble theme={theme} message={item} />}
					ListFooterComponent={
						<>
							{draft ? <DraftBubble theme={theme} draft={draft} /> : null}
							{error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
						</>
					}
				/>
			)}
			<View style={[styles.composer, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
				<TextInput
					value={input}
					onChangeText={setInput}
					placeholder="Escribe un mensaje"
					placeholderTextColor={theme.muted}
					multiline
					style={[styles.input, { color: theme.text }]}
				/>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={busy ? "Detener" : "Enviar"}
					onPress={busy ? () => abort.current?.abort() : send}
					style={[styles.send, { backgroundColor: busy || input.trim() ? theme.btn : theme.soft }]}
				>
					<Text style={{ color: busy || input.trim() ? theme.btnText : theme.muted, fontSize: 18, fontWeight: "700" }}>{busy ? "■" : "↑"}</Text>
				</Pressable>
			</View>
		</KeyboardAvoidingView>
	);
}

function Steps({ theme, steps }: { theme: Theme; steps: { label: string; done: boolean; ok?: boolean }[] }) {
	if (!steps.length) return null;
	return (
		<View style={{ gap: 2, marginBottom: 6 }}>
			{steps.map((st, i) => (
				<Text key={i} numberOfLines={1} style={{ color: st.ok === false ? theme.danger : theme.muted, fontSize: 13 }}>
					{st.done ? (st.ok === false ? "✕" : "✓") : "…"} {st.label}
				</Text>
			))}
		</View>
	);
}

function Bubble({ theme, message }: { theme: Theme; message: ChatMessage }) {
	const text = messageText(message.content);
	if (message.role === "user") {
		return (
			<View style={[styles.user, { backgroundColor: theme.userBubble }]}>
				<Text selectable style={{ color: theme.text, fontSize: 16, lineHeight: 22 }}>{text || "(imagen)"}</Text>
			</View>
		);
	}
	return (
		<View style={styles.assistant}>
			{message.agentName ? <Text style={{ color: theme.accent, fontWeight: "600", marginBottom: 4 }}>{message.agentName}</Text> : null}
			<Steps theme={theme} steps={(message.tools ?? []).map((t) => ({ label: t.label, done: true, ok: t.ok }))} />
			<Markdown text={text} theme={theme} />
		</View>
	);
}

function DraftBubble({ theme, draft }: { theme: Theme; draft: Draft }) {
	return (
		<View style={styles.assistant}>
			<Steps theme={theme} steps={draft.steps} />
			{draft.text ? <Markdown text={draft.text} theme={theme} /> : <ActivityIndicator style={{ alignSelf: "flex-start" }} color={theme.muted} />}
		</View>
	);
}

const styles = StyleSheet.create({
	list: { padding: 16, gap: 14, flexGrow: 1 },
	empty: { textAlign: "center", fontSize: 20, marginTop: 80 },
	user: { alignSelf: "flex-end", maxWidth: "85%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
	assistant: { alignSelf: "stretch" },
	error: { fontSize: 14, lineHeight: 20, marginTop: 8 },
	composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, margin: 10, borderWidth: 1, borderRadius: 24, paddingLeft: 14, padding: 6 },
	input: { flex: 1, fontSize: 16, maxHeight: 140, paddingVertical: 8 },
	send: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
