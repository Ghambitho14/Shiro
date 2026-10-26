import { useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { listModels } from "../core/ollama";
import { normalizeSupabaseUrl, testSupabase } from "../core/supabase";
import type { AppSettings } from "../core/types";
import { saveSettings } from "../settings";
import type { Theme } from "../theme";
import { Button, Header, IconButton } from "../ui/common";

type Props = { theme: Theme; initial: AppSettings; firstRun: boolean; onSaved: (s: AppSettings) => void; onBack?: () => void };

export function SettingsScreen({ theme, initial, firstRun, onSaved, onBack }: Props) {
	const [s, setS] = useState<AppSettings>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [models, setModels] = useState<string[] | null>(null);
	const [loadingModels, setLoadingModels] = useState(false);
	const set = (k: keyof AppSettings) => (v: string) => setS((prev) => ({ ...prev, [k]: v }));

	const field = (label: string, key: keyof AppSettings, opts: { secret?: boolean; placeholder?: string; help?: string; link?: [string, string] } = {}) => (
		<View style={styles.field}>
			<Text style={[styles.label, { color: theme.text }]}>{label}</Text>
			<TextInput
				value={s[key]}
				onChangeText={set(key)}
				placeholder={opts.placeholder}
				placeholderTextColor={theme.muted}
				secureTextEntry={opts.secret}
				autoCapitalize="none"
				autoCorrect={false}
				style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.elevated }]}
			/>
			{opts.help ? <Text style={[styles.help, { color: theme.muted }]}>{opts.help}</Text> : null}
			{opts.link ? (
				<Text onPress={() => Linking.openURL(opts.link![1])} style={[styles.help, { color: theme.accent }]}>
					{opts.link[0]}
				</Text>
			) : null}
		</View>
	);

	async function loadModels() {
		setLoadingModels(true);
		setError("");
		try {
			setModels(await listModels({ key: s.ollamaKey }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingModels(false);
		}
	}

	async function save() {
		setBusy(true);
		setError("");
		const clean: AppSettings = {
			...s,
			supabaseUrl: normalizeSupabaseUrl(s.supabaseUrl),
			supabaseKey: s.supabaseKey.trim(),
			ollamaKey: s.ollamaKey.trim(),
			model: s.model.trim(),
			assistantName: s.assistantName.trim(),
		};
		try {
			if (!clean.ollamaKey) throw new Error("Falta la API key de Ollama Cloud.");
			if (!clean.model) throw new Error("Elige un modelo de Ollama Cloud.");
			const problem = await testSupabase({ url: clean.supabaseUrl, key: clean.supabaseKey });
			if (problem) throw new Error(problem);
			await saveSettings(clean);
			onSaved(clean);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
			<Header theme={theme} title="Ajustes" left={onBack ? <IconButton theme={theme} label="‹" accessibilityLabel="Volver" onPress={onBack} /> : undefined} />
			<ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
				{firstRun ? (
					<Text style={[styles.intro, { color: theme.text }]}>
						Bienvenido. Esta app es tu Shiro en el móvil: piensa con Ollama Cloud y guarda todo en tu Supabase, el mismo que usa Shiro en el PC. Así sabe lo mismo en los dos sitios, aunque el PC esté apagado.
					</Text>
				) : null}

				<Text style={[styles.section, { color: theme.muted }]}>SUPABASE (TU MEMORIA)</Text>
				{field("Dirección del proyecto", "supabaseUrl", { placeholder: "https://xxxx.supabase.co", help: "La misma que en Shiro del PC: Ajustes → Datos." })}
				{field("Clave secreta", "supabaseKey", {
					secret: true,
					placeholder: "sb_secret_… o eyJ…",
					help: "Supabase → Project Settings → API Keys. Se guarda cifrada en este teléfono. Si lo pierdes, cámbiala en Supabase.",
				})}

				<Text style={[styles.section, { color: theme.muted }]}>OLLAMA CLOUD (EL MODELO)</Text>
				{field("API key", "ollamaKey", { secret: true, placeholder: "Tu clave de ollama.com", link: ["Crear una clave en ollama.com/settings/keys", "https://ollama.com/settings/keys"] })}
				{field("Modelo", "model", { placeholder: "gpt-oss:120b", help: "Sin «-cloud» al final (gpt-oss:120b, no gpt-oss:120b-cloud)." })}
				<Button theme={theme} kind="secondary" title="Ver modelos" busy={loadingModels} onPress={loadModels} style={{ alignSelf: "flex-start" }} />
				{models ? (
					<View style={styles.chips}>
						{models.map((m) => (
							<Pressable
								key={m}
								onPress={() => set("model")(m)}
								style={[styles.chip, { borderColor: m === s.model ? theme.accent : theme.border, backgroundColor: m === s.model ? theme.accentSoft : "transparent" }]}
							>
								<Text style={{ color: theme.text, fontSize: 13 }}>{m}</Text>
							</Pressable>
						))}
					</View>
				) : null}

				<Text style={[styles.section, { color: theme.muted }]}>OPCIONAL</Text>
				{field("Nombre del asistente", "assistantName", { placeholder: "Vacío = el mismo que en el PC" })}

				{error ? <Text style={[styles.error, { color: theme.danger }]}>{error}</Text> : null}
				<Button theme={theme} title={firstRun ? "Probar y empezar" : "Probar y guardar"} busy={busy} onPress={save} style={{ marginTop: 8 }} />
			</ScrollView>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	body: { padding: 16, gap: 12, paddingBottom: 48 },
	intro: { fontSize: 15, lineHeight: 22 },
	section: { fontSize: 12, fontWeight: "700", letterSpacing: 0.6, marginTop: 12 },
	field: { gap: 6 },
	label: { fontSize: 15, fontWeight: "600" },
	input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
	help: { fontSize: 13, lineHeight: 18 },
	chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
	chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6 },
	error: { fontSize: 14, lineHeight: 20 },
});
