/**
 * La pantalla de chat con el diseño de Shiro de escritorio en pantalla estrecha: barra superior
 * (barra lateral, nombre + modelo, tema, nuevo chat, menú del chat), portada «¿En qué puedo ayudarte?»
 * con sugerencias, mensajes (copiar, leer en voz alta, regenerar, editar), comandos con «/»,
 * adjuntos y modo voz.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { runAgentTurn } from "../core/agent";
import { helpText, parseCommand } from "../core/commands";
import { buildContent, replaceText, type Attachment } from "../core/content";
import { listModels } from "../core/ollama";
import { buildSystemPrompt } from "../core/prompt";
import { listReminders } from "../core/reminders";
import { deleteChat, getChat, getNotes, listChats, renameChat, saveChat, type SupabaseConn } from "../core/supabase";
import { messageText } from "../core/text";
import type { AppSettings, ChatMessage, ChatMeta, FetchFn } from "../core/types";
import { syncReminderNotifications } from "../notifications";
import { radius, type Theme } from "../theme";
import { speak, stopSpeaking } from "../voice";
import { Button, confirm, IconButton } from "../ui/common";
import { Composer } from "../ui/Composer";
import { Icon, type IconName } from "../ui/Icon";
import { AssistantMessage, UserMessage, type Step } from "../ui/Message";
import { Sidebar } from "../ui/Sidebar";
import { VoiceOverlay } from "../ui/VoiceOverlay";

const HERO = require("../../assets/avatar.png");

/** fetch de Expo: deja leer la respuesta mientras llega (la de React Native no). */
const streamingFetch = expoFetch as unknown as FetchFn;

/** Las sugerencias de la web que sirven en el móvil (las del PC no). */
const SUGGESTIONS: { icon: IconName; text: string }[] = [
	{ icon: "globe", text: "¿Qué noticias hay hoy?" },
	{ icon: "bell", text: "Recuérdame tomar agua en 1 hora" },
	{ icon: "sparkles", text: "¿Qué recuerdas de mí?" },
];

const REMINDER_TOOLS = new Set(["create_reminder", "complete_reminder"]);

type Draft = { text: string; steps: Step[] };
/** Mensaje que solo se ve aquí (la ayuda de /ayuda): no se guarda en el chat. */
type Shown = ChatMessage & { local?: boolean };

type Props = {
	theme: Theme;
	sb: SupabaseConn;
	settings: AppSettings;
	assistantName: string;
	userName: string;
	onSettings: () => void;
	onReminders: () => void;
	onChangeSettings: (patch: Partial<AppSettings>) => void;
	/** Para que el botón «atrás» de Android cierre primero la barra lateral. */
	registerBack: (fn: (() => boolean) | null) => void;
};

export function MainScreen({ theme, sb, settings, assistantName, userName, onSettings, onReminders, onChangeSettings, registerBack }: Props) {
	const [chats, setChats] = useState<ChatMeta[]>([]);
	const [meta, setMeta] = useState<ChatMeta | null>(null);
	const [messages, setMessages] = useState<Shown[]>([]);
	const [loading, setLoading] = useState(false);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState("");
	const [sidebar, setSidebar] = useState(false);
	const [modelMenu, setModelMenu] = useState(false);
	const [chatMenu, setChatMenu] = useState(false);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [voiceOpen, setVoiceOpen] = useState(false);
	const [speakingAt, setSpeakingAt] = useState<number | null>(null);
	const abort = useRef<AbortController | null>(null);
	const list = useRef<FlatList<Shown>>(null);
	// Lo último, para el modo voz (sus funciones viven más que un render).
	const latest = useRef({ messages, meta });
	latest.current = { messages, meta };

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

	useEffect(
		() => () => {
			abort.current?.abort();
			stopSpeaking();
		},
		[],
	);

	function newChat() {
		abort.current?.abort();
		stopSpeaking();
		setSpeakingAt(null);
		setMeta(null);
		setMessages([]);
		setError("");
		setSidebar(false);
	}

	async function openChat(chat: ChatMeta) {
		abort.current?.abort();
		stopSpeaking();
		setSpeakingAt(null);
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
			if (latest.current.meta?.id === chat.id) newChat();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function saveTitle(title: string) {
		const chat = latest.current.meta;
		setRenaming(null);
		if (!chat) return;
		try {
			await renameChat(sb, chat.id, title);
			setMeta({ ...chat, title: title.replace(/\s+/g, " ").trim() });
			void refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Pide una respuesta para `base` (que acaba en un mensaje del usuario), la va pintando y guarda
	 * el chat antes y después. Devuelve el texto de la respuesta ("" si falló o se paró).
	 */
	async function respond(base: ChatMessage[], opts: { voice?: boolean } = {}): Promise<string> {
		if (abort.current) return "";
		setError("");
		setMessages(base);
		const current: Draft = { text: "", steps: [] };
		setDraft({ text: "", steps: [] });
		const controller = new AbortController();
		abort.current = controller;
		let saved = latest.current.meta;
		try {
			saved = await saveChat(sb, saved ?? {}, base);
			setMeta(saved);
			const system = buildSystemPrompt(await getNotes(sb), { assistantName: settings.assistantName, voice: opts.voice });
			const result = await runAgentTurn(
				{ sb, ollama: { key: settings.ollamaKey, fetch: streamingFetch }, model: settings.model, system, signal: controller.signal },
				base,
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
			const all = [...base, answer];
			// La respuesta pasa del borrador a la lista a la vez (si no, se ve dos veces mientras se guarda).
			setDraft(null);
			setMessages(all);
			setMeta(await saveChat(sb, saved, all));
			if (result.tools.some((t) => REMINDER_TOOLS.has(t.name))) {
				void listReminders(sb)
					.then(syncReminderNotifications)
					.catch(() => {});
			}
			return result.text;
		} catch (err) {
			if (controller.signal.aborted) {
				// Parado a mano: se guarda lo que alcanzó a escribir.
				if (current.text.trim()) {
					const all: ChatMessage[] = [...base, { role: "assistant", content: `${current.text.trim()}\n\n_(detenido)_`, ts: Date.now() }];
					setDraft(null);
					setMessages(all);
					await saveChat(sb, saved ?? {}, all).catch(() => {});
				}
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
			return "";
		} finally {
			if (abort.current === controller) abort.current = null;
			setDraft(null);
			void refresh();
		}
	}

	/** Lo que se guarda: sin los mensajes solo locales (la ayuda). */
	const stored = () => latest.current.messages.filter((m) => !m.local).map(({ local: _l, ...m }) => m);

	function runCommand(text: string): boolean {
		const cmd = parseCommand(text);
		if (!cmd) return false;
		if (cmd.command === "nuevo") newChat();
		else if (cmd.command === "ayuda") setMessages((m) => [...m, { role: "assistant", content: helpText(), local: true }]);
		else if (cmd.command === "modelo") {
			if (cmd.arg) onChangeSettings({ model: cmd.arg });
			else setModelMenu(true);
		} else if (cmd.command === "recordatorios") onReminders();
		else if (cmd.command === "voz") setVoiceOpen(true);
		else if (cmd.command === "ajustes") onSettings();
		return true;
	}

	function send(text: string, attachments: Attachment[] = []) {
		if (!attachments.length && runCommand(text)) return;
		void respond([...stored(), { role: "user", content: buildContent(text, attachments), ts: Date.now() }]);
	}

	function regenerate() {
		const msgs = stored();
		let lastUser = msgs.length - 1;
		while (lastUser >= 0 && msgs[lastUser].role !== "user") lastUser--;
		if (lastUser >= 0) void respond(msgs.slice(0, lastUser + 1));
	}

	function edit(index: number, text: string) {
		const msgs = latest.current.messages;
		const target = msgs[index];
		const before = msgs.slice(0, index).filter((m) => !m.local).map(({ local: _l, ...m }) => m);
		void respond([...before, { ...target, content: replaceText(target.content, text), ts: Date.now() }]);
	}

	function toggleSpeak(index: number, text: string) {
		if (speakingAt === index) {
			stopSpeaking();
			setSpeakingAt(null);
			return;
		}
		setSpeakingAt(index);
		speak(text, { onDone: () => setSpeakingAt((cur) => (cur === index ? null : cur)) });
	}

	const askByVoice = useCallback(async (text: string) => {
		const answer = await respond([...stored(), { role: "user", content: text, ts: Date.now() }], { voice: true });
		if (!answer) throw new Error("No hubo respuesta. Toca la esfera para intentarlo otra vez.");
		return answer;
		// respond y stored leen lo último por refs; no hace falta recrear esto en cada render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [settings.model, settings.ollamaKey, settings.assistantName]);

	const empty = !messages.length && !draft && !loading;
	const lastAssistant = messages.reduce((acc, m, i) => (m.role === "assistant" && !m.local ? i : acc), -1);
	const composer = (
		<Composer
			theme={theme}
			busy={Boolean(draft)}
			assistantName={assistantName}
			onSend={send}
			onStop={() => abort.current?.abort()}
			onVoiceMode={() => setVoiceOpen(true)}
			onError={setError}
		/>
	);

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
				{meta ? (
					<IconButton theme={theme} icon="dots" label="Opciones del chat" onPress={() => setChatMenu(true)} />
				) : (
					<IconButton theme={theme} icon="edit" label="Nuevo chat" onPress={newChat} />
				)}
			</View>

			{empty ? (
				<ScrollView contentContainerStyle={styles.emptyWrap} keyboardShouldPersistTaps="handled">
					<View style={styles.hero}>
						<Image source={HERO} style={styles.heroImg} />
						<Text style={[styles.heroTitle, { color: theme.text }]}>¿En qué puedo ayudarte?</Text>
					</View>
					{composer}
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
							renderItem={({ item, index }) =>
								item.role === "user" ? (
									<UserMessage theme={theme} message={item} busy={Boolean(draft)} onEdit={(t) => edit(index, t)} />
								) : (
									<AssistantMessage
										theme={theme}
										text={messageText(item.content)}
										agentName={item.agentName}
										steps={(item.tools ?? []).map((t) => ({ label: t.label, status: t.ok ? "ok" : "fail" }))}
										speaking={speakingAt === index}
										onSpeak={() => toggleSpeak(index, messageText(item.content))}
										onRegenerate={index === lastAssistant && !draft ? regenerate : undefined}
									/>
								)
							}
							ListFooterComponent={
								draft ? (
									<AssistantMessage theme={theme} text={draft.text} steps={draft.steps} streaming />
								) : error ? (
									<AssistantMessage theme={theme} text="" steps={[]} error={error} onRegenerate={stored().at(-1)?.role === "user" ? regenerate : undefined} />
								) : undefined
							}
						/>
					)}
					<View style={styles.bottom}>
						{composer}
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
			<ChatMenu
				theme={theme}
				visible={chatMenu}
				onClose={() => setChatMenu(false)}
				onNew={() => {
					setChatMenu(false);
					newChat();
				}}
				onRename={() => {
					setChatMenu(false);
					setRenaming(meta?.title ?? "");
				}}
				onDelete={() => {
					setChatMenu(false);
					if (meta) void removeChat(meta);
				}}
			/>
			<RenameDialog theme={theme} value={renaming} onCancel={() => setRenaming(null)} onSave={saveTitle} />
			<VoiceOverlay visible={voiceOpen} assistantName={assistantName} onClose={() => setVoiceOpen(false)} ask={askByVoice} />
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
				onVoice={() => {
					setSidebar(false);
					setVoiceOpen(true);
				}}
				onReminders={() => {
					setSidebar(false);
					onReminders();
				}}
				onSettings={() => {
					setSidebar(false);
					onSettings();
				}}
			/>
		</KeyboardAvoidingView>
	);
}

/** Menú de los tres puntos (como el de la web): nuevo, renombrar y borrar. */
function ChatMenu({ theme, visible, onClose, onNew, onRename, onDelete }: { theme: Theme; visible: boolean; onClose: () => void; onNew: () => void; onRename: () => void; onDelete: () => void }) {
	const item = (icon: IconName, label: string, onPress: () => void, danger = false) => (
		<Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: theme.hover }]}>
			<Icon name={icon} size={18} color={danger ? theme.danger : theme.text2} />
			<Text style={{ color: danger ? theme.danger : theme.text, fontSize: 15 }}>{label}</Text>
		</Pressable>
	);
	return (
		<Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
			<Pressable style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.2)" }]} onPress={onClose} />
			<View style={[styles.menu, styles.menuRight, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
				{item("edit", "Nuevo chat", onNew)}
				{item("pencil", "Renombrar", onRename)}
				{item("trash", "Borrar chat", onDelete, true)}
			</View>
		</Modal>
	);
}

function RenameDialog({ theme, value, onCancel, onSave }: { theme: Theme; value: string | null; onCancel: () => void; onSave: (v: string) => void }) {
	const [text, setText] = useState("");
	useEffect(() => {
		if (value !== null) setText(value);
	}, [value]);
	return (
		<Modal visible={value !== null} transparent animationType="fade" onRequestClose={onCancel}>
			<Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]} onPress={onCancel} />
			<View style={[styles.dialog, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
				<Text style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>Renombrar chat</Text>
				<TextInput
					value={text}
					onChangeText={setText}
					autoFocus
					selectTextOnFocus
					onSubmitEditing={() => onSave(text)}
					style={[styles.dialogInput, { color: theme.text, borderColor: theme.border }]}
				/>
				<View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
					<Button theme={theme} kind="secondary" title="Cancelar" onPress={onCancel} />
					<Button theme={theme} title="Guardar" onPress={() => onSave(text)} />
				</View>
			</View>
		</Modal>
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
	menuItem: { flexDirection: "row", alignItems: "center", gap: 10, height: 44, paddingHorizontal: 10, borderRadius: radius.sm },
	menuRight: { left: undefined, width: 220, right: 12 },
	dialog: { position: "absolute", top: "30%", left: 24, right: 24, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: 18, gap: 14, elevation: 16 },
	dialogInput: { borderWidth: 1, borderRadius: radius.sm + 2, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
