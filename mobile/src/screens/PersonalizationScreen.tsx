/**
 * Personalización (como Ajustes → Personalización de la web): «Sobre ti», instrucciones base,
 * SOUL.md, MEMORY.md y TOOLS.md. Se guardan en Supabase (shiro_notes) y el PC los recibe en su
 * próxima sincronización (cada 20 s).
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { parseProfileNote, profileToMarkdown, type ProfileFields } from "../core/prompt";
import { getNotes, saveNote, type Notes, type SupabaseConn } from "../core/supabase";
import { radius, type Theme } from "../theme";
import { Button, IconButton } from "../ui/common";
import { Icon } from "../ui/Icon";

type NoteKey = "Instrucciones.md" | "SOUL.md" | "MEMORY.md" | "TOOLS.md";

const NOTES: { key: NoteKey; title: string; desc: string }[] = [
	{ key: "Instrucciones.md", title: "Instrucciones base", desc: "Lo primero que lee antes de responder: quién es, cómo usa las herramientas y sus reglas. Puedes usar {{nombre}}, {{usuario}} y {{fecha}}." },
	{ key: "SOUL.md", title: "Personalidad (SOUL.md)", desc: "Su forma de ser, sus límites y su tono." },
	{ key: "MEMORY.md", title: "Memoria (MEMORY.md)", desc: "Lo importante que debe tener siempre presente." },
	{ key: "TOOLS.md", title: "Guía de herramientas (TOOLS.md)", desc: "Cómo elegir herramientas. Habla sobre todo de las del PC." },
];

type Props = { theme: Theme; sb: SupabaseConn; onBack: () => void; onSaved: () => void };

export function PersonalizationScreen({ theme, sb, onBack, onSaved }: Props) {
	const [notes, setNotes] = useState<Notes | null>(null);
	const [editing, setEditing] = useState<NoteKey | "profile" | null>(null);
	const [text, setText] = useState("");
	const [profile, setProfile] = useState<ProfileFields>({ userName: "", language: "", about: "", extra: "" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState("");

	useEffect(() => {
		getNotes(sb)
			.then((n) => {
				setNotes(n);
				setProfile(parseProfileNote(n["Sobre mí.md"]));
			})
			.catch((err) => setError(err instanceof Error ? err.message : String(err)));
	}, [sb]);

	async function save() {
		if (!editing) return;
		setBusy(true);
		setError("");
		try {
			if (editing === "profile") {
				const md = profileToMarkdown(profile);
				await saveNote(sb, "Sobre mí.md", md);
				setNotes((n) => ({ ...n, "Sobre mí.md": md }));
			} else {
				if (!text.trim()) throw new Error("La nota no puede quedar vacía.");
				await saveNote(sb, editing, text);
				setNotes((n) => ({ ...n, [editing]: text }));
			}
			setSaved("Guardado. El PC lo tendrá en unos segundos.");
			setTimeout(() => setSaved(""), 3000);
			setEditing(null);
			onSaved();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const input = (label: string, value: string, onChange: (v: string) => void, opts: { multiline?: boolean; placeholder?: string } = {}) => (
		<View style={{ gap: 6 }}>
			<Text style={{ color: theme.text, fontSize: 15, fontWeight: "600" }}>{label}</Text>
			<TextInput
				value={value}
				onChangeText={onChange}
				multiline={opts.multiline}
				placeholder={opts.placeholder}
				placeholderTextColor={theme.text3}
				style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated }, opts.multiline && { minHeight: 110, textAlignVertical: "top" }]}
			/>
		</View>
	);

	const current = NOTES.find((n) => n.key === editing);
	return (
		<KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<View style={styles.header}>
				<IconButton theme={theme} icon="arrowLeft" label="Volver" onPress={editing ? () => setEditing(null) : onBack} />
				<Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
					{editing === "profile" ? "Sobre ti" : current?.title ?? "Personalización"}
				</Text>
			</View>
			<ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
				{!notes && !error ? <ActivityIndicator color={theme.text3} style={{ marginTop: 24 }} /> : null}
				{error ? <Text style={{ color: theme.danger, fontSize: 14 }}>{error}</Text> : null}
				{saved ? <Text style={{ color: theme.success, fontSize: 14 }}>{saved}</Text> : null}

				{notes && !editing ? (
					<>
						<Text style={[styles.section, { color: theme.text3 }]}>SOBRE TI</Text>
						<Pressable onPress={() => setEditing("profile")} style={({ pressed }) => [styles.row, { borderColor: theme.border }, pressed && { backgroundColor: theme.hover }]}>
							<View style={{ flex: 1 }}>
								<Text style={{ color: theme.text, fontSize: 15, fontWeight: "500" }}>{profile.userName || "Tu nombre y lo que debe saber de ti"}</Text>
								<Text numberOfLines={2} style={{ color: theme.text3, fontSize: 13 }}>
									{profile.about || "Nombre, idioma, qué debería saber de ti y cómo quieres que responda."}
								</Text>
							</View>
							<Icon name="chevronRight" size={18} color={theme.text3} />
						</Pressable>
						<Text style={[styles.section, { color: theme.text3 }]}>LO QUE LEE ANTES DE RESPONDER</Text>
						{NOTES.map((n) => (
							<Pressable
								key={n.key}
								onPress={() => {
									setText(notes[n.key] ?? "");
									setEditing(n.key);
								}}
								style={({ pressed }) => [styles.row, { borderColor: theme.border }, pressed && { backgroundColor: theme.hover }]}
							>
								<View style={{ flex: 1 }}>
									<Text style={{ color: theme.text, fontSize: 15, fontWeight: "500" }}>{n.title}</Text>
									<Text numberOfLines={2} style={{ color: theme.text3, fontSize: 13 }}>
										{n.desc}
									</Text>
								</View>
								<Icon name="chevronRight" size={18} color={theme.text3} />
							</Pressable>
						))}
						<Text style={{ color: theme.text3, fontSize: 12.5, marginTop: 8 }}>
							Son las mismas notas que en Shiro del PC (Ajustes → Personalización). Si aún no aparecen, abre Shiro en el PC con Supabase activado para que las suba.
						</Text>
					</>
				) : null}

				{editing === "profile" ? (
					<>
						{input("Nombre", profile.userName, (v) => setProfile((p) => ({ ...p, userName: v })), { placeholder: "Cómo te llamas" })}
						{input("Idioma", profile.language, (v) => setProfile((p) => ({ ...p, language: v })), { placeholder: "español" })}
						{input("Qué debería saber de ti", profile.about, (v) => setProfile((p) => ({ ...p, about: v })), { multiline: true })}
						{input("Cómo quieres que responda", profile.extra, (v) => setProfile((p) => ({ ...p, extra: v })), { multiline: true })}
						<Button theme={theme} title="Guardar" busy={busy} onPress={save} style={{ alignSelf: "flex-start" }} />
					</>
				) : null}

				{current ? (
					<>
						<Text style={{ color: theme.text2, fontSize: 14, lineHeight: 20 }}>{current.desc}</Text>
						<TextInput
							value={text}
							onChangeText={setText}
							multiline
							style={[styles.input, styles.editor, { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated }]}
						/>
						<Button theme={theme} title="Guardar" busy={busy} onPress={save} style={{ alignSelf: "flex-start" }} />
					</>
				) : null}
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	header: { height: 56, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 6 },
	title: { fontSize: 18, fontWeight: "600", flex: 1 },
	body: { padding: 16, gap: 12, paddingBottom: 48 },
	section: { fontSize: 12, fontWeight: "700", letterSpacing: 0.6, marginTop: 8 },
	row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm },
	input: { borderWidth: 1, borderRadius: radius.sm + 2, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
	editor: { minHeight: 320, textAlignVertical: "top", fontFamily: "monospace", fontSize: 14, lineHeight: 20 },
});
