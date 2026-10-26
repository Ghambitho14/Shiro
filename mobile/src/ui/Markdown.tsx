/** Markdown sencillo para las respuestas: títulos, listas, **negrita**, `código` y bloques de código. */
import { Fragment } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { mono, type Theme } from "../theme";

function Inline({ text, theme }: { text: string; theme: Theme }) {
	const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
	return (
		<>
			{parts.map((p, i) => {
				if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <Text key={i} style={{ fontWeight: "700" }}>{p.slice(2, -2)}</Text>;
				if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
					return <Text key={i} style={{ fontFamily: mono, backgroundColor: theme.code, fontSize: 14 }}>{p.slice(1, -1)}</Text>;
				}
				return <Fragment key={i}>{p}</Fragment>;
			})}
		</>
	);
}

export function Markdown({ text, theme }: { text: string; theme: Theme }) {
	const blocks = text.split(/```[^\n]*\n?/);
	return (
		<View style={{ gap: 6 }}>
			{blocks.map((block, i) => {
				if (i % 2 === 1) {
					return (
						<ScrollView key={i} horizontal style={[styles.code, { backgroundColor: theme.code, borderColor: theme.border }]}>
							<Text selectable style={{ fontFamily: mono, color: theme.text, fontSize: 13 }}>{block.replace(/\n$/, "")}</Text>
						</ScrollView>
					);
				}
				return block
					.split("\n")
					.filter((line, j, all) => line.trim() || (j > 0 && all[j - 1].trim()))
					.map((line, j) => {
						const h = /^(#{1,6})\s+(.*)$/.exec(line);
						if (h) return <Text key={`${i}-${j}`} selectable style={[styles.p, { color: theme.text, fontWeight: "700", fontSize: h[1].length <= 2 ? 19 : 17 }]}><Inline text={h[2]} theme={theme} /></Text>;
						const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
						if (li) {
							return (
								<View key={`${i}-${j}`} style={{ flexDirection: "row", paddingLeft: 4 + li[1].length * 4 }}>
									<Text style={[styles.p, { color: theme.text, width: li[2].length > 1 ? 26 : 16 }]}>{/\d/.test(li[2]) ? li[2] : "•"}</Text>
									<Text selectable style={[styles.p, { color: theme.text, flex: 1 }]}><Inline text={li[3]} theme={theme} /></Text>
								</View>
							);
						}
						if (!line.trim()) return <View key={`${i}-${j}`} style={{ height: 2 }} />;
						return <Text key={`${i}-${j}`} selectable style={[styles.p, { color: theme.text }]}><Inline text={line} theme={theme} /></Text>;
					});
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	p: { fontSize: 16, lineHeight: 23 },
	code: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
});
