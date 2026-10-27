/**
 * Mensajes con el aspecto de la web (public/js/messages.js y .msg de app.css): burbuja gris a la
 * derecha para ti; avatar + texto para Shiro, con sus pasos plegables y el botón Copiar.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ChatMessage } from "../core/types";
import { splitContent } from "../core/content";
import { radius, type Theme } from "../theme";
import { Icon, type IconName } from "./Icon";
import { Markdown } from "./Markdown";

const AVATAR = require("../../assets/avatar.png");

export type Step = { label: string; status: "running" | "ok" | "fail" };

function Spinner({ color }: { color: string }) {
	const spin = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }));
		loop.start();
		return () => loop.stop();
	}, [spin]);
	const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
	return (
		<Animated.View style={{ transform: [{ rotate }] }}>
			<Icon name="loader" size={16} color={color} />
		</Animated.View>
	);
}

/** Punto que parpadea mientras piensa (.thinking-dot). */
export function ThinkingDot({ theme }: { theme: Theme }) {
	const o = useRef(new Animated.Value(1)).current;
	useEffect(() => {
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(o, { toValue: 0.25, duration: 550, useNativeDriver: true }),
				Animated.timing(o, { toValue: 1, duration: 550, useNativeDriver: true }),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [o]);
	return <Animated.View style={[styles.dot, { backgroundColor: theme.text, opacity: o }]} />;
}

/** «1 acción» / «N acciones» / «Trabajando…», con la lista plegable (como .steps de la web). */
function Steps({ theme, steps, running }: { theme: Theme; steps: Step[]; running: boolean }) {
	const [open, setOpen] = useState(running);
	useEffect(() => {
		if (running) setOpen(true);
	}, [running]);
	if (!steps.length) return null;
	const label = running ? "Trabajando…" : steps.length === 1 ? "1 acción" : `${steps.length} acciones`;
	return (
		<View style={{ marginBottom: 10 }}>
			<Pressable onPress={() => setOpen((v) => !v)} style={styles.stepsToggle} hitSlop={6}>
				<View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
					<Icon name="chevronDown" size={16} color={theme.text3} />
				</View>
				<Text style={{ color: theme.text3, fontSize: 14 }}>{label}</Text>
			</Pressable>
			{open ? (
				<View style={[styles.stepsList, { borderColor: theme.border }]}>
					{steps.map((st, i) => (
						<View key={i} style={styles.step}>
							{st.status === "running" ? (
								<Spinner color={theme.accent} />
							) : (
								<Icon name={st.status === "ok" ? "check" : "x"} size={16} color={st.status === "ok" ? theme.success : theme.danger} />
							)}
							<Text style={{ color: theme.text2, fontSize: 14, lineHeight: 20, flex: 1 }}>{st.label}</Text>
						</View>
					))}
				</View>
			) : null}
		</View>
	);
}

function ActionButton({ theme, icon, label, onPress, active }: { theme: Theme; icon: IconName; label: string; onPress: () => void; active?: boolean }) {
	return (
		<Pressable accessibilityLabel={label} hitSlop={4} onPress={onPress} style={({ pressed }) => [styles.action, pressed && { backgroundColor: theme.hover }]}>
			<Icon name={icon} size={17} color={active ? theme.accent : theme.text3} />
		</Pressable>
	);
}

function CopyButton({ theme, text }: { theme: Theme; text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<ActionButton
			theme={theme}
			icon={copied ? "check" : "copy"}
			label="Copiar"
			onPress={async () => {
				await Clipboard.setStringAsync(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		/>
	);
}

export function UserMessage({
	theme,
	message,
	onEdit,
	busy,
}: {
	theme: Theme;
	message: ChatMessage;
	/** Guardar el texto editado (se borra lo que venía después y se vuelve a preguntar). */
	onEdit?: (text: string) => void;
	busy?: boolean;
}) {
	const { text, files, images } = splitContent(message.content);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(text);
	if (editing) {
		return (
			<View style={[styles.editBox, { backgroundColor: theme.soft }]}>
				<TextInput value={draft} onChangeText={setDraft} multiline autoFocus style={{ color: theme.text, fontSize: 16, lineHeight: 24, minHeight: 60 }} />
				<View style={styles.editRow}>
					<Pressable onPress={() => setEditing(false)} style={[styles.editBtn, { borderColor: theme.border }]}>
						<Text style={{ color: theme.text, fontSize: 14 }}>Cancelar</Text>
					</Pressable>
					<Pressable
						onPress={() => {
							setEditing(false);
							if (draft.trim() && draft.trim() !== text) onEdit?.(draft.trim());
						}}
						style={[styles.editBtn, { backgroundColor: theme.btn, borderColor: theme.btn }]}
					>
						<Text style={{ color: theme.btnText, fontSize: 14, fontWeight: "500" }}>Enviar</Text>
					</Pressable>
				</View>
			</View>
		);
	}
	return (
		<View style={styles.userRow}>
			{images.length || files.length ? (
				<View style={styles.files}>
					{images.map((url, i) => (
						<Image key={i} source={{ uri: url }} style={[styles.image, { borderColor: theme.border }]} />
					))}
					{files.map((name, i) => (
						<View key={`f${i}`} style={[styles.fileChip, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
							<Icon name="file" size={16} color={theme.text2} />
							<Text numberOfLines={1} style={{ color: theme.text, fontSize: 13, maxWidth: 180 }}>
								{name}
							</Text>
						</View>
					))}
				</View>
			) : null}
			{text ? (
				<View style={[styles.bubble, { backgroundColor: theme.soft }, images.length || files.length ? { borderTopRightRadius: 8 } : null]}>
					<Text selectable style={{ color: theme.text, fontSize: 16, lineHeight: 24 }}>
						{text}
					</Text>
				</View>
			) : null}
			<View style={styles.userActions}>
				{text ? <CopyButton theme={theme} text={text} /> : null}
				{onEdit && !busy ? (
					<ActionButton
						theme={theme}
						icon="pencil"
						label="Editar"
						onPress={() => {
							setDraft(text);
							setEditing(true);
						}}
					/>
				) : null}
			</View>
		</View>
	);
}

export function AssistantMessage({
	theme,
	text,
	steps,
	agentName,
	streaming,
	error,
	speaking,
	onSpeak,
	onRegenerate,
}: {
	theme: Theme;
	text: string;
	steps: Step[];
	agentName?: string;
	streaming?: boolean;
	error?: string;
	speaking?: boolean;
	onSpeak?: () => void;
	onRegenerate?: () => void;
}) {
	const running = Boolean(streaming && steps.some((s) => s.status === "running"));
	return (
		<View style={styles.assistantRow}>
			<Image source={AVATAR} style={[styles.avatar, { borderColor: theme.border }]} />
			<View style={{ flex: 1, minWidth: 0 }}>
				{agentName ? <Text style={{ color: theme.accent, fontWeight: "600", marginBottom: 4 }}>{agentName}</Text> : null}
				<Steps theme={theme} steps={steps} running={running} />
				{text ? <Markdown text={text} theme={theme} /> : streaming && !running ? <ThinkingDot theme={theme} /> : null}
				{error ? (
					<View style={[styles.error, { backgroundColor: theme.dangerSoft }]}>
						<Icon name="alert" size={18} color={theme.danger} />
						<Text style={{ color: theme.text, fontSize: 14, lineHeight: 20, flex: 1 }}>{error}</Text>
					</View>
				) : null}
				{(text || onRegenerate) && !streaming ? (
					<View style={styles.actions}>
						{text ? <CopyButton theme={theme} text={text} /> : null}
						{text && onSpeak ? <ActionButton theme={theme} icon={speaking ? "pause" : "volume"} label={speaking ? "Dejar de leer" : "Leer en voz alta"} onPress={onSpeak} active={speaking} /> : null}
						{onRegenerate ? <ActionButton theme={theme} icon="refresh" label="Regenerar respuesta" onPress={onRegenerate} /> : null}
					</View>
				) : null}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	userRow: { alignItems: "flex-end" },
	bubble: { maxWidth: "82%", borderRadius: 22, paddingHorizontal: 18, paddingVertical: 10 },
	userActions: { flexDirection: "row", marginTop: 4, marginRight: -6 },
	files: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, marginBottom: 6, maxWidth: "82%" },
	image: { width: 160, height: 160, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
	fileChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
	editBox: { borderRadius: 22, paddingHorizontal: 14, paddingVertical: 12 },
	editRow: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 6 },
	editBtn: { paddingHorizontal: 14, height: 36, borderRadius: 18, borderWidth: 1, alignItems: "center", justifyContent: "center" },
	assistantRow: { flexDirection: "row", gap: 12 },
	avatar: { width: 30, height: 30, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, marginTop: 1 },
	dot: { width: 12, height: 12, borderRadius: 6, marginTop: 7 },
	stepsToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2, alignSelf: "flex-start" },
	stepsList: { gap: 6, marginTop: 6, paddingLeft: 12, borderLeftWidth: 2 },
	step: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
	error: { flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 12, borderRadius: radius.md, marginTop: 4 },
	actions: { flexDirection: "row", marginTop: 4, marginLeft: -8 },
	action: { width: 34, height: 34, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
});
