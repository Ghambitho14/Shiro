/**
 * La pantalla de chat con el diseño de Shiro de escritorio en pantalla estrecha: barra superior
 * (barra lateral, nombre + modelo, tema, nuevo chat), portada «¿En qué puedo ayudarte?» con
 * sugerencias, mensajes y el cuadro de texto abajo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { runAgentTurn } from "../core/agent";
import { listModels } from "../core/ollama";
import { buildSystemPrompt } from "../core/prompt";
import { deleteChat, getChat, getNotes, listChats, saveChat, type SupabaseConn } from "../core/supabase";
import { messageText } from "../core/text";
import type { AppSettings, ChatMessage, ChatMeta, FetchFn } from "../core/types";
import { radius, type Theme } from "../theme";
import { confirm, IconButton } from "../ui/common";
import { Composer } from "../ui/Composer";
import { Icon, type IconName } from "../ui/Icon";
import { AssistantMessage, UserMessage, type Step } from "../ui/Message";
import { Sidebar } from "../ui/Sidebar";

const HERO = require("../../assets/avatar.png");

/** fetch de Expo: deja leer la respuesta mientras llega (la de React Native no). */
const streamingFetch = expoFetch as unknown as FetchFn;

/** Las sugerencias de la web que sirven en el móvil (las del PC no). */
const SUGGESTIONS: { icon: IconName; text: string }[] = [
	{ icon: "globe", text: "¿Qué noticias hay hoy?" },
	{ icon: "sparkles", text: "¿Qué recuerdas de mí?" },
	{ icon: "search", text: "Busca el clima de hoy en mi ciudad" },
];

type Draft = { text: string; steps: Step[] };

type Props = {
	theme: Theme;
	sb: SupabaseConn;
	settings: AppSettings;
	assistantName: string;
	userName: string;
	onSettings: () => void;
	onChangeSettings: (patch: Partial<AppSettings>) => void;
	/** Para que el botón «atrás» de Android cierre primero la barra lateral. */
	registerBack: (fn: (() => boolean) | null) => void;
};

export function MainScreen({ theme, sb, settings, assistantName, userName, onSettings, onChangeSettings, registerBack }: Props) {
	const [chats, setChats] = useState<ChatMeta[]>([]);
	const [meta, setMeta] = useState<ChatMeta | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState("");
	const [sidebar, setSidebar] = useState(false);
	const [modelMenu, setModelMenu] = useState(false);
	const abort = useRef<AbortController | null>(null);
	const list = useRef<FlatList<ChatMessage>>(null);

	const refresh = useCallback(async () => {
		try {
			setChats(await listChats(sb));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [sb]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		registerBack(sidebar ? () => (setSidebar(false), true) : null);
		return () => registerBack(null);
	}, [sidebar, registerBack]);

	useEffect(() => () => abort.current?.abort(), []);

	function newChat() {
		abort.current?.abort();
		setMeta(null);
		setMessages([]);
		setError("");
		setSidebar(false);
	}

	async function openChat(chat: ChatMeta) {
		abort.current?.abort();
		setSidebar(false);
		setMeta(chat);
		setMessages([]);
		setError("");
		setLoading(true);
		try {
			// Lo último de Supabase: puede que el PC haya escrito algo.
			const full = await getChat(sb, chat.id);
			if (full) {
				setMeta(full);
				setMessages(full.messages);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	async function removeChat(chat: ChatMeta) {
		if (!(await confirm("Borrar chat", `«${chat.title}» se borra también en el PC.`, "Borrar"))) return;
		try {
			await deleteChat(sb, chat.id);
			setChats((prev) => prev.filter((c) => c.id !== chat.id));
			if (meta?.id === chat.id) newChat();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function send(text: string) {
		if (draft) return;
		setError("");
		const withUser: ChatMessage[] = [...messages, { role: "user", content: text, ts: Date.now() }];
		setMessages(withUser);
		const current: Draft = { text: "", steps: [] };
		setDraft({ text: "", steps: [] });
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
						setDraft({ text: current.text, steps: [...current.steps] });
					},
					onTool: (label, done, ok) => {
						if (!done) current.steps.push({ label, status: "running" });
						else {
							const i = current.steps.findIndex((s) => s.label === label && s.status === "running");
							if (i >= 0) current.steps[i] = { label, status: ok === false ? "fail" : "ok" };
						}
						setDraft({ text: current.text, steps: [...current.steps] });
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
			if (abort.current === controller) abort.current = null;
			setDraft(null);
			void refresh();
		}
	}

	const empty = !messages.length && !draft && !loading;

	return (
		<KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<View style={styles.topbar}>
				<IconButton theme={theme} icon="panel" label="Abrir barra lateral" onPress={() => setSidebar(true)} />
				<Pressable onPress={() => setModelMenu(true)} style={({ pressed }) => [styles.modelBtn, pressed && { backgroundColor: theme.hover }]} accessibilityLabel="Cambiar de modelo">
					<Text style={[styles.modelName, { color: theme.text }]} numberOfLines={1}>
						{assistantName}
					</Text>
					<Text style={[styles.modelSub, { color: theme.text3 }]} numberOfLines={1}>
						{settings.model}
					</Text>
					<Icon name="chevronDown" size={16} color={theme.text3} />
				</Pressable>
				<View style={{ flex: 1 }} />
				<IconButton
					theme={theme}
					icon={theme.dark ? "sun" : "moon"}
					label="Cambiar tema"
					onPress={() => onChangeSettings({ theme: theme.dark ? "light" : "dark" })}
				/>
				<IconButton theme={theme} icon="edit" label="Nuevo chat" onPress={newChat} />
			</View>

			{empty ? (
				<ScrollView contentContainerStyle={styles.emptyWrap} keyboardShouldPersistTaps="handled">
					<View style={styles.hero}>
						<Image source={HERO} style={styles.heroImg} />
						<Text style={[styles.heroTitle, { color: theme.text }]}>¿En qué puedo ayudarte?</Text>
					</View>
					<Composer theme={theme} busy={false} assistantName={assistantName} onSend={send} onStop={() => abort.current?.abort()} />
					<View style={styles.suggestions}>
						{SUGGESTIONS.map((s) => (
							<Pressable
								key={s.text}
								onPress={() => send(s.text)}
								style={({ pressed }) => [styles.suggestion, { borderColor: theme.border }, pressed && { backgroundColor: theme.hover }]}
							>
								<Icon name={s.icon} size={16} color={theme.text2} />
								<Text style={{ color: theme.text2, fontSize: 14 }}>{s.text}</Text>
							</Pressable>
						))}
					</View>
					{error ? <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text> : null}
				</ScrollView>
			) : (
				<>
					{loading ? (
						<ActivityIndicator style={{ marginTop: 40, flex: 1 }} color={theme.text3} />
					) : (
						<FlatList
							ref={list}
							data={messages}
							keyExtractor={(_, i) => String(i)}
							contentContainerStyle={styles.thread}
							keyboardShouldPersistTaps="handled"
							onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
							renderItem={({ item }) =>
								item.role === "user" ? (
									<UserMessage theme={theme} message={item} />
								) : (
									<AssistantMessage
										theme={theme}
										text={messageText(item.content)}
										agentName={item.agentName}
										steps={(item.tools ?? []).map((t) => ({ label: t.label, status: t.ok ? "ok" : "fail" }))}
									/>
								)
							}
							ListFooterComponent={
								draft ? (
									<AssistantMessage theme={theme} text={draft.text} steps={draft.steps} streaming />
								) : error ? (
									<AssistantMessage theme={theme} text="" steps={[]} error={error} />
								) : undefined
							}
						/>
					)}
					<View style={styles.bottom}>
						<Composer theme={theme} busy={Boolean(draft)} assistantName={assistantName} onSend={send} onStop={() => abort.current?.abort()} />
						<Text style={[styles.disclaimer, { color: theme.text3 }]}>Shiro puede equivocarse.</Text>
					</View>
				</>
			)}

			<ModelMenu
				theme={theme}
				visible={modelMenu}
				ollamaKey={settings.ollamaKey}
				current={settings.model}
				onClose={() => setModelMenu(false)}
				onPick={(model) => {
					setModelMenu(false);
					onChangeSettings({ model });
				}}
			/>
			<Sidebar
				theme={theme}
				open={sidebar}
				onClose={() => setSidebar(false)}
				assistantName={assistantName}
				userName={userName}
				chats={chats}
				activeId={meta?.id ?? null}
				onNew={newChat}
				onOpen={openChat}
				onDelete={removeChat}
				onSettings={() => {
					setSidebar(false);
					onSettings();
				}}
			/>
		</KeyboardAvoidingView>
	);
}

/** Menú de modelos (como el de .model-btn en la web), con los de Ollama Cloud. */
function ModelMenu({
	theme,
	visible,
	ollamaKey,
	current,
	onClose,
	onPick,
}: {
	theme: Theme;
	visible: boolean;
	ollamaKey: string;
	current: string;
	onClose: () => void;
	onPick: (model: string) => void;
}) {
	const [models, setModels] = useState<string[] | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		if (!visible || models) return;
		listModels({ key: ollamaKey })
			.then(setModels)
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [visible, models, ollamaKey]);
	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.2)" }]} onPress={onClose} />
			<View style={[styles.menu, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
				<Text style={[styles.menuTitle, { color: theme.text3 }]}>Modelo de Ollama Cloud</Text>
				{error ? <Text style={{ color: theme.danger, padding: 10, fontSize: 14 }}>{error}</Text> : null}
				{!models && !error ? <ActivityIndicator style={{ padding: 16 }} color={theme.text3} /> : null}
				<ScrollView style={{ maxHeight: 380 }}>
					{(models ?? []).map((m) => (
						<Pressable key={m} onPress={() => onPick(m)} style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: theme.hover }]}>
							<Text style={{ color: theme.text, fontSize: 15, flex: 1 }} numberOfLines={1}>
								{m}
							</Text>
							{m === current ? <Icon name="check" size={18} color={theme.text} /> : null}
						</Pressable>
					))}
				</ScrollView>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	topbar: { height: 56, flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 6 },
	modelBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 40, paddingHorizontal: 10, borderRadius: radius.sm, flexShrink: 1, minWidth: 0 },
	modelName: { fontSize: 17, fontWeight: "500" },
	modelSub: { fontSize: 15, flexShrink: 1 },
	emptyWrap: { flexGrow: 1, justifyContent: "center", paddingHorizontal: 16, paddingBottom: 96 },
	hero: { alignItems: "center", paddingBottom: 28 },
	heroImg: { width: 64, height: 64, borderRadius: 18, marginBottom: 14 },
	heroTitle: { fontSize: 26, fontWeight: "500", textAlign: "center" },
	suggestions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, marginTop: 16 },
	suggestion: { flexDirection: "row", alignItems: "center", gap: 8, height: 40, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1 },
	thread: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 24, gap: 26 },
	bottom: { paddingHorizontal: 10, paddingBottom: 6 },
	disclaimer: { textAlign: "center", fontSize: 12, paddingTop: 8 },
	errorText: { textAlign: "center", fontSize: 14, marginTop: 16 },
	menu: {
		position: "absolute",
		top: 60,
		left: 12,
		right: 12,
		borderRadius: radius.md,
		borderWidth: StyleSheet.hairlineWidth,
		padding: 6,
		shadowColor: "#000",
		shadowOpacity: 0.18,
		shadowRadius: 24,
		elevation: 12,
	},
	menuTitle: { fontSize: 12, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 8 },
	menuItem: { flexDirection: "row", alignItems: "center", gap: 8, height: 42, paddingHorizontal: 10, borderRadius: radius.sm },
});
