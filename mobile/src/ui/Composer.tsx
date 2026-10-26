/** El cuadro de texto de la web (.composer): píldora redondeada, campo que crece y botón redondo de enviar/detener. */
import { useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { radius, type Theme } from "../theme";
import { Icon } from "./Icon";

type Props = { theme: Theme; busy: boolean; assistantName: string; onSend: (text: string) => void; onStop: () => void };

export function Composer({ theme, busy, assistantName, onSend, onStop }: Props) {
	const [text, setText] = useState("");
	const ready = text.trim().length > 0;
	const send = () => {
		if (!ready || busy) return;
		onSend(text.trim());
		setText("");
	};
	// En el teléfono el campo crece solo (entre minHeight y maxHeight); en el navegador se calcula por líneas.
	const webHeight = Platform.OS === "web" ? { height: Math.min(180, 20 + 24 * Math.max(1, text.split("\n").length)) } : null;
	return (
		<View style={[styles.box, { backgroundColor: theme.composer, borderColor: theme.dark ? "transparent" : theme.border }]}>
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
				<View style={{ flex: 1 }} />
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={busy ? "Detener" : "Enviar"}
					onPress={busy ? onStop : send}
					style={({ pressed }) => [
						styles.round,
						{ backgroundColor: theme.btn, opacity: busy || ready ? 1 : 0.3, transform: [{ scale: pressed ? 0.94 : 1 }] },
					]}
				>
					<Icon name={busy ? "stop" : "arrowUp"} size={18} color={theme.btnText} strokeWidth={busy ? 2 : 2.4} />
				</Pressable>
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
	round: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
