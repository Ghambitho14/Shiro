/**
 * Modo voz, como el de la web (public/js/voiceMode.js): pantalla oscura con la esfera dorada
 * (azul mientras piensa o habla). Escucha una frase, la manda, lee la respuesta y vuelve a escuchar.
 * Tocar la esfera interrumpe la lectura; la X cierra.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { speak, startListening, stopListening, stopSpeaking } from "../voice";
import { Icon } from "./Icon";

type Phase = "idle" | "listening" | "thinking" | "speaking";

const GOLD = ["rgba(205,130,0,0.18)", "rgba(245,185,20,0.28)", "rgba(255,215,55,0.55)", "rgba(255,236,140,0.85)", "#fffbe2"];
const BLUE = ["rgba(18,70,200,0.18)", "rgba(35,120,245,0.28)", "rgba(70,170,255,0.55)", "rgba(150,205,255,0.85)", "#eef7ff"];

function Orb({ phase, onPress }: { phase: Phase; onPress: () => void }) {
	const pulse = useRef(new Animated.Value(0)).current;
	useEffect(() => {
		const speed = phase === "speaking" ? 520 : phase === "thinking" ? 900 : phase === "listening" ? 1300 : 2200;
		const loop = Animated.loop(
			Animated.sequence([
				Animated.timing(pulse, { toValue: 1, duration: speed, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
				Animated.timing(pulse, { toValue: 0, duration: speed, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
			]),
		);
		loop.start();
		return () => loop.stop();
	}, [phase, pulse]);
	const colors = phase === "thinking" || phase === "speaking" ? BLUE : GOLD;
	const sizes = [280, 220, 160, 110, 64];
	const amp = phase === "speaking" ? 0.12 : phase === "listening" ? 0.08 : 0.04;
	return (
		<Pressable onPress={onPress} accessibilityLabel="Esfera del modo voz" style={styles.orb}>
			{sizes.map((size, i) => (
				<Animated.View
					key={i}
					style={[
						styles.ring,
						{
							width: size,
							height: size,
							borderRadius: size / 2,
							backgroundColor: colors[i],
							transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1 - amp * (i % 2), 1 + amp * ((i + 1) / sizes.length)] }) }],
						},
					]}
				/>
			))}
		</Pressable>
	);
}

type Props = {
	visible: boolean;
	assistantName: string;
	onClose: () => void;
	/** Manda lo que dijo el usuario al chat y devuelve la respuesta (ya guardada). */
	ask: (text: string) => Promise<string>;
};

export function VoiceOverlay({ visible, assistantName, onClose, ask }: Props) {
	const [phase, setPhase] = useState<Phase>("idle");
	const [status, setStatus] = useState("");
	const [heard, setHeard] = useState("");
	const open = useRef(false);
	const said = useRef("");

	const listen = useCallback(async () => {
		if (!open.current) return;
		said.current = "";
		setHeard("");
		setPhase("listening");
		setStatus("Te escucho…");
		const ok = await startListening({
			onText: (t) => {
				said.current = t;
				setHeard(t);
			},
			onEnd: async () => {
				if (!open.current) return;
				const text = said.current.trim();
				if (!text) {
					setPhase("idle");
					setStatus("Toca la esfera para hablar");
					return;
				}
				setPhase("thinking");
				setStatus("Pensando…");
				try {
					const answer = await ask(text);
					if (!open.current) return;
					setPhase("speaking");
					setStatus("Hablando… toca la esfera para interrumpir");
					speak(answer, { onDone: () => open.current && void listen() });
				} catch (err) {
					setPhase("idle");
					setStatus(err instanceof Error ? err.message : String(err));
				}
			},
			onError: (m) => {
				setPhase("idle");
				setStatus(m);
			},
		});
		if (!ok) setPhase("idle");
	}, [ask]);

	useEffect(() => {
		open.current = visible;
		if (visible) void listen();
		else {
			stopListening();
			stopSpeaking();
			setPhase("idle");
		}
		return () => {
			open.current = false;
			stopListening();
			stopSpeaking();
		};
	}, [visible, listen]);

	function tapOrb() {
		if (phase === "speaking") {
			stopSpeaking();
			void listen();
		} else if (phase === "listening") stopListening();
		else if (phase === "idle") void listen();
	}

	return (
		<Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
			<View style={[styles.wrap, { backgroundColor: phase === "thinking" || phase === "speaking" ? "#0b0f17" : "#0d0d0b" }]}>
				<View style={styles.top}>
					<View style={styles.title}>
						<Icon name="voice" size={16} color="#b4b4b4" />
						<Text style={{ color: "#b4b4b4", fontSize: 14, fontWeight: "500" }}>Modo voz · {assistantName}</Text>
					</View>
					<Pressable onPress={onClose} accessibilityLabel="Cerrar modo voz" style={styles.close} hitSlop={8}>
						<Icon name="x" size={22} color="#ececec" />
					</Pressable>
				</View>
				<View style={styles.center}>
					<Orb phase={phase} onPress={tapOrb} />
					<Text style={styles.status}>{status}</Text>
					{heard ? (
						<Text style={styles.heard} numberOfLines={3}>
							«{heard}»
						</Text>
					) : null}
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	wrap: { flex: 1 },
	top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 40, paddingBottom: 14 },
	title: { flexDirection: "row", alignItems: "center", gap: 8 },
	close: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.08)" },
	center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 28, paddingHorizontal: 24, paddingBottom: 60 },
	orb: { width: 300, height: 300, alignItems: "center", justifyContent: "center" },
	ring: { position: "absolute" },
	status: { color: "#ececec", fontSize: 18, fontWeight: "500", textAlign: "center" },
	heard: { color: "#b4b4b4", fontSize: 15, textAlign: "center", lineHeight: 22 },
});
