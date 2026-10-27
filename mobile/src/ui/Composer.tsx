/**
 * El cuadro de texto de la web (.composer): píldora redondeada con adjuntos encima, botón + (fotos,
 * cámara, archivos), dictado con el micrófono, menú de comandos al escribir «/» y el botón redondo:
 * modo voz si está vacío, enviar si hay algo, detener mientras responde.
 */
import { useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Attachment } from "../core/content";
import { matchCommands } from "../core/commands";
import { pickImages, pickTextFiles, takePhoto } from "../attachments";
import { radius, type Theme } from "../theme";
import { startListening, stopListening } from "../voice";
import { Icon, type IconName } from "./Icon";

const MAX_ATTACHMENTS = 6;

type Props = {
	theme: Theme;
	busy: boolean;
	assistantName: string;
	onSend: (text: string, attachments: Attachment[]) => void;
	onStop: () => void;
	onVoiceMode: () => void;
	onError: (message: string) => void;
};

export function Composer({ theme, busy, assistantName, onSend, onStop, onVoiceMode, onError }: Props) {
	const [text, setText] = useState("");
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [menu, setMenu] = useState(false);
	const [listening, setListening] = useState(false);
	const before = useRef("");
	const ready = text.trim().length > 0 || attachments.length > 0;
	const commands = matchCommands(text);

	useEffect(() => () => stopListening(), []);

	const send = (value = text) => {
		if (busy || (!value.trim() && !attachments.length)) return;
		if (listening) stopListening();
		onSend(value.trim(), attachments);
		setText("");
		setAttachments([]);
	};

	async function attach(kind: "images" | "camera" | "files") {
		setMenu(false);
		const room = MAX_ATTACHMENTS - attachments.length;
		if (room <= 0) return onError(`Como mucho ${MAX_ATTACHMENTS} adjuntos por mensaje.`);
		try {
			const got = kind === "images" ? await pickImages(room) : kind === "camera" ? await takePhoto() : await pickTextFiles(room);
			setAttachments((prev) => [...prev, ...got].slice(0, MAX_ATTACHMENTS));
		} catch (err) {
			onError(err instanceof Error ? err.message : String(err));
		}
	}

	async function dictate() {
		if (listening) return stopListening();
		before.current = text.trim() ? `${text.trim()} ` : "";
		const ok = await startListening({
			onText: (t) => setText(before.current + t),
			onEnd: () => setListening(false),
			onError: (m) => {
				setListening(false);
				onError(m);
			},
		});
		setListening(ok);
	}

	// En el teléfono el campo crece solo (entre minHeight y maxHeight); en el navegador se calcula por líneas.
	const webHeight = Platform.OS === "web" ? { height: Math.min(180, 20 + 24 * Math.max(1, text.split("\n").length)) } : null;
	const menuItem = (icon: IconName, label: string, onPress: () => void) => (
		<Pressable onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && { backgroundColor: theme.hover }]}>
			<Icon name={icon} size={18} color={theme.text2} />
			<Text style={{ color: theme.text, fontSize: 15 }}>{label}</Text>
		</Pressable>
	);

	return (
		<View>
			{commands.length ? (
				<View style={[styles.popover, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
					{commands.map((c) => (
						<Pressable
							key={c.name}
							onPress={() => (c.usage ? setText(`/${c.name} `) : send(`/${c.name}`))}
							style={({ pressed }) => [styles.cmd, pressed && { backgroundColor: theme.hover }]}
						>
							<Text style={{ color: theme.text, fontSize: 15, fontWeight: "500" }}>{c.usage ?? `/${c.name}`}</Text>
							<Text style={{ color: theme.text3, fontSize: 13 }}>{c.description}</Text>
						</Pressable>
					))}
				</View>
			) : null}
			{menu ? (
				<View style={[styles.popover, { backgroundColor: theme.elevated, borderColor: theme.border }]}>
					{menuItem("image", "Fotos de la galería", () => attach("images"))}
					{Platform.OS !== "web" ? menuItem("camera", "Hacer una foto", () => attach("camera")) : null}
					{menuItem("file", "Archivo de texto", () => attach("files"))}
				</View>
			) : null}
			<View style={[styles.box, { backgroundColor: theme.composer, borderColor: theme.dark ? "transparent" : theme.border }]}>
				{attachments.length ? (
					<ScrollView horizontal contentContainerStyle={styles.attachments} keyboardShouldPersistTaps="handled">
						{attachments.map((a, i) => (
							<View key={i} style={styles.attachment}>
								{a.kind === "image" ? (
									<Image source={{ uri: a.dataUrl }} style={[styles.thumb, { borderColor: theme.border }]} />
								) : (
									<View style={[styles.fileChip, { borderColor: theme.border, backgroundColor: theme.elevated }]}>
										<Icon name="file" size={16} color={theme.text2} />
										<Text numberOfLines={1} style={{ color: theme.text, fontSize: 13, maxWidth: 140 }}>
											{a.name}
										</Text>
									</View>
								)}
								<Pressable
									accessibilityLabel={`Quitar ${a.name}`}
									onPress={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
									style={[styles.remove, { backgroundColor: theme.btn }]}
									hitSlop={6}
								>
									<Icon name="x" size={12} color={theme.btnText} strokeWidth={2.6} />
								</Pressable>
							</View>
						))}
					</ScrollView>
				) : null}
				<TextInput
					value={text}
					onChangeText={setText}
					placeholder={`Pregúntale o pídele algo a ${assistantName}`}
					placeholderTextColor={theme.text3}
					multiline
					style={[styles.input, { color: theme.text }, webHeight]}
					accessibilityLabel="Mensaje"
				/>
				<View style={styles.bar}>
					<Pressable accessibilityLabel="Adjuntar" onPress={() => setMenu((v) => !v)} style={({ pressed }) => [styles.icon, pressed && { backgroundColor: theme.hover }]}>
						<Icon name="plus" size={20} color={theme.text2} />
					</Pressable>
					{listening ? (
						<View style={styles.hint}>
							<View style={[styles.recDot, { backgroundColor: theme.danger }]} />
							<Text style={{ color: theme.accent, fontSize: 12.5 }}>Escuchando…</Text>
						</View>
					) : null}
					<View style={{ flex: 1 }} />
					<Pressable
						accessibilityLabel={listening ? "Dejar de dictar" : "Dictar"}
						onPress={dictate}
						style={({ pressed }) => [styles.icon, (pressed || listening) && { backgroundColor: listening ? theme.accentSoft : theme.hover }]}
					>
						<Icon name={listening ? "micOff" : "mic"} size={20} color={listening ? theme.accent : theme.text2} />
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel={busy ? "Detener" : ready ? "Enviar" : "Modo voz"}
						onPress={busy ? onStop : ready ? () => send() : onVoiceMode}
						style={({ pressed }) => [styles.round, { backgroundColor: theme.btn, transform: [{ scale: pressed ? 0.94 : 1 }] }]}
					>
						<Icon name={busy ? "stop" : ready ? "arrowUp" : "voice"} size={18} color={theme.btnText} strokeWidth={busy ? 2 : 2.4} />
					</Pressable>
				</View>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	box: {
		borderRadius: radius.xl,
		borderWidth: 1,
		paddingTop: 8,
		paddingHorizontal: 10,
		paddingBottom: 10,
		shadowColor: "#000",
		shadowOpacity: 0.05,
		shadowRadius: 12,
		shadowOffset: { width: 0, height: 2 },
	},
	input: { fontSize: 16, lineHeight: 24, minHeight: 44, maxHeight: 180, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6, textAlignVertical: "top" },
	bar: { flexDirection: "row", alignItems: "center", gap: 4 },
	icon: { width: 36, height: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
	round: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
	hint: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6 },
	recDot: { width: 8, height: 8, borderRadius: 4 },
	attachments: { gap: 8, paddingHorizontal: 4, paddingTop: 4, paddingBottom: 4 },
	attachment: { position: "relative", paddingTop: 6, paddingRight: 6 },
	thumb: { width: 64, height: 64, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
	fileChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, height: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
	remove: { position: "absolute", top: 0, right: 0, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
	popover: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 6, marginBottom: 8, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 16, elevation: 8 },
	menuItem: { flexDirection: "row", alignItems: "center", gap: 10, height: 44, paddingHorizontal: 10, borderRadius: radius.sm },
	cmd: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.sm, gap: 2 },
});
