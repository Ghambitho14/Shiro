/**
 * Markdown de las respuestas con el aspecto de la web: párrafos, títulos, listas, citas, **negrita**,
 * *cursiva*, `código`, enlaces y bloques de código con su cabecera (lenguaje + Copiar).
 */
import { Fragment, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { mono, radius, type Theme } from "../theme";
import { Icon } from "./Icon";

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\)|https?:\/\/[^\s)]+|\*[^*\s][^*]*\*)/g;

function Inline({ text, theme }: { text: string; theme: Theme }) {
	return (
		<>
			{text.split(INLINE).map((p, i) => {
				if (!p) return null;
				if (p.startsWith("**") && p.endsWith("**") && p.length > 4) return <Text key={i} style={{ fontWeight: "700" }}>{p.slice(2, -2)}</Text>;
				if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
					return <Text key={i} style={{ fontFamily: mono, backgroundColor: theme.soft, fontSize: 14 }}>{` ${p.slice(1, -1)} `}</Text>;
				}
				const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
				if (link || /^https?:\/\//.test(p)) {
					const url = link ? link[2] : p;
					return (
						<Text key={i} style={{ color: theme.accent, textDecorationLine: "underline" }} onPress={() => Linking.openURL(url)}>
							{link ? link[1] : p}
						</Text>
					);
				}
				if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <Text key={i} style={{ fontStyle: "italic" }}>{p.slice(1, -1)}</Text>;
				return <Fragment key={i}>{p}</Fragment>;
			})}
		</>
	);
}

function CodeBlock({ code, lang, theme }: { code: string; lang: string; theme: Theme }) {
	const [copied, setCopied] = useState(false);
	return (
		<View style={[styles.code, { backgroundColor: theme.code, borderColor: theme.border }]}>
			<View style={[styles.codeHead, { backgroundColor: theme.codeHead }]}>
				<Text style={{ color: theme.text2, fontSize: 12.5 }}>{lang || "código"}</Text>
				<Pressable
					hitSlop={8}
					onPress={async () => {
						await Clipboard.setStringAsync(code);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					}}
					style={styles.codeCopy}
				>
					<Icon name={copied ? "check" : "copy"} size={14} color={theme.text2} />
					<Text style={{ color: theme.text2, fontSize: 12.5 }}>{copied ? "Copiado" : "Copiar"}</Text>
				</Pressable>
			</View>
			<ScrollView horizontal contentContainerStyle={{ padding: 14 }}>
				<Text selectable style={{ fontFamily: mono, color: theme.text, fontSize: 13, lineHeight: 20 }}>{code}</Text>
			</ScrollView>
		</View>
	);
}

export function Markdown({ text, theme }: { text: string; theme: Theme }) {
	const out: React.ReactNode[] = [];
	const pushText = (block: string, key: string) => {
		const lines = block.replace(/\n{3,}/g, "\n\n").split("\n");
		let para: string[] = [];
		const flush = (k: string) => {
			if (!para.length) return;
			out.push(
				<Text key={k} selectable style={[styles.p, { color: theme.text }]}>
					<Inline text={para.join("\n")} theme={theme} />
				</Text>,
			);
			para = [];
		};
		lines.forEach((line, j) => {
			const k = `${key}-${j}`;
			const h = /^(#{1,6})\s+(.*)$/.exec(line);
			const li = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
			const quote = /^>\s?(.*)$/.exec(line);
			if (h) {
				flush(`${k}p`);
				out.push(
					<Text key={k} selectable style={[styles.h, { color: theme.text, fontSize: h[1].length === 1 ? 22 : h[1].length === 2 ? 19 : 17 }]}>
						<Inline text={h[2]} theme={theme} />
					</Text>,
				);
			} else if (li) {
				flush(`${k}p`);
				const num = /\d/.test(li[2]);
				out.push(
					<View key={k} style={[styles.li, { paddingLeft: 4 + Math.min(li[1].length, 8) * 6 }]}>
						<Text style={[styles.p, styles.bullet, { color: theme.text, width: num ? 26 : 18 }]}>{num ? li[2] : "•"}</Text>
						<Text selectable style={[styles.p, styles.liText, { color: theme.text }]}>
							<Inline text={li[3]} theme={theme} />
						</Text>
					</View>,
				);
			} else if (quote) {
				flush(`${k}p`);
				out.push(
					<View key={k} style={[styles.quote, { borderColor: theme.border }]}>
						<Text selectable style={[styles.p, styles.liText, { color: theme.text2 }]}>
							<Inline text={quote[1]} theme={theme} />
						</Text>
					</View>,
				);
			} else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
				flush(`${k}p`);
				out.push(<View key={k} style={[styles.hr, { backgroundColor: theme.border }]} />);
			} else if (!line.trim()) {
				flush(`${k}p`);
			} else {
				para.push(line);
			}
		});
		flush(`${key}-end`);
	};
	// Bloques de código entre ```; si la respuesta aún llega, el último puede no estar cerrado.
	let buf: string[] = [];
	let code: string[] | null = null;
	let lang = "";
	let n = 0;
	for (const line of text.split("\n")) {
		const fence = /^\s*```(.*)$/.exec(line);
		if (fence && code === null) {
			pushText(buf.join("\n"), `t${n++}`);
			buf = [];
			code = [];
			lang = fence[1].trim();
		} else if (fence && code !== null) {
			out.push(<CodeBlock key={`c${n++}`} code={code.join("\n")} lang={lang} theme={theme} />);
			code = null;
		} else (code ?? buf).push(line);
	}
	if (code !== null) out.push(<CodeBlock key={`c${n++}`} code={code.join("\n")} lang={lang} theme={theme} />);
	else pushText(buf.join("\n"), `t${n++}`);
	return <View style={{ gap: 10 }}>{out}</View>;
}

const styles = StyleSheet.create({
	p: { fontSize: 16, lineHeight: 25 },
	h: { fontWeight: "600", lineHeight: 28, marginTop: 4 },
	li: { flexDirection: "row" },
	bullet: { textAlign: "left" },
	liText: { flex: 1 },
	quote: { borderLeftWidth: 3, paddingLeft: 12 },
	hr: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
	code: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
	codeHead: { height: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 14, paddingRight: 10 },
	codeCopy: { flexDirection: "row", alignItems: "center", gap: 6 },
});
