// Cajita de voz de la bandeja («Hablarle» en el ícono de Aku, tray.ts): la misma web en una ventana chica
// (`/?mini=voz`), con el modo voz de siempre (voiceMode.js) pero otra vista: las ondas de tu voz (rojo) o de
// la de Aku (azul), y el texto de a poco en dos líneas fijas (lo viejo sube y se esconde, así la caja no crece).
// La ventana la coloca abajo a la derecha y siempre encima `pinWindowToCorner` (pc.ts), buscándola por su
// título «<nombre> (voz)»: por eso aquí el título no cambia con el chat.
import { $, el } from "./ui.js";
import { hydrateIcons, setIcon } from "./icons.js";
import { state } from "./state.js";
import { loadSettings } from "./settings.js";
import { setVoiceView, voice } from "./voiceMode.js";

export const isMiniVoice = () => new URLSearchParams(location.search).get("mini") === "voz";

/** Caracteres por segundo del texto de Aku mientras habla (más o menos lo que tarda en decirlo). */
const SPEAK_CPS = 15;
/** Si no está hablando (pensando, o sin voz), el texto pendiente sale más rápido. */
const QUIET_CPS = 45;
const BARS = 26;

/** "Voz" simulada mientras Aku habla (la voz del navegador no da volumen), como en orb.js. */
function speechPulse(t) {
	const syllable = Math.max(0, Math.sin(t * 11.3) * 0.6 + Math.sin(t * 7.1 + 1.7) * 0.4);
	const phrase = 0.55 + 0.45 * Math.sin(t * 1.9 + 0.5);
	return 0.12 + 0.6 * syllable * phrase;
}

export async function initMiniVoice() {
	state.mini = true;
	document.body.classList.add("mini-voz");
	document.documentElement.dataset.theme = "dark";
	document.title = `${state.name} (voz)`;

	const box = el(
		"div",
		"mini-voz-box",
		`<canvas class="mv-wave" title="Toca para interrumpir o hablar"></canvas>
		<div class="mv-main">
			<div class="mv-text" aria-live="polite"><div class="mv-lines"></div></div>
			<div class="mv-approval"></div>
			<div class="mv-foot">
				<span class="mv-status">Preparando…</span>
				<span class="mv-actions">
					<button type="button" class="icon-btn sm mv-mute" aria-label="Pausar micrófono" title="Pausar micrófono" data-icon="mic"></button>
					<button type="button" class="icon-btn sm mv-close" aria-label="Cerrar" title="Cerrar (Esc)" data-icon="x"></button>
				</span>
			</div>
		</div>`,
	);
	document.body.append(box);
	hydrateIcons(box);
	const canvas = $(".mv-wave", box);
	const lines = $(".mv-lines", box);
	const statusEl = $(".mv-status", box);
	const approvalEl = $(".mv-approval", box);
	const muteBtn = $(".mv-mute", box);

	// Texto: lo del usuario sale al momento; lo de Aku, de a poco (al ritmo en que lo dice).
	const text = { target: "", shown: 0, who: "user" };
	const paintText = () => {
		lines.classList.toggle("user", text.who === "user");
		const n = Math.floor(text.shown);
		// Palabra por palabra: mientras falta texto, no se enseña una palabra a medias.
		const end = n >= text.target.length ? n : Math.max(0, text.target.lastIndexOf(" ", n));
		lines.textContent = text.target.slice(0, end);
	};
	// Ondas: el historial de niveles, de izquierda (viejo) a derecha (nuevo).
	const levels = new Array(BARS).fill(0);
	let micLevel = 0;
	let phase = "idle";

	setVoiceView({
		big: false,
		transcript(value, who) {
			const continues = who === text.who && value.startsWith(text.target.slice(0, Math.floor(text.shown)));
			text.who = who;
			text.target = value;
			if (who === "user") text.shown = value.length;
			else if (!continues) text.shown = 0;
			paintText();
		},
		level: (l) => (micLevel = l),
		phase(p, label) {
			phase = p;
			statusEl.textContent = label.replace(/ · toca el círculo para hablar|… toca el círculo para interrumpir/, "…");
		},
		approval(node) {
			box.classList.toggle("asking", Boolean(node));
			approvalEl.replaceChildren(...(node ? [node] : []));
		},
		mute(muted) {
			setIcon(muteBtn, muted ? "micOff" : "mic");
			muteBtn.classList.toggle("muted", muted);
			muteBtn.title = muted ? "Activar micrófono" : "Pausar micrófono";
		},
		closed: () => window.close(),
	});

	muteBtn.onclick = () => voice.toggleMute();
	$(".mv-close", box).onclick = () => voice.close();
	canvas.onclick = () => voice.tap();

	const ctx = canvas.getContext("2d");
	let last = performance.now();
	let sample = 0;
	const frame = (now) => {
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		// Texto de a poco.
		if (text.who === "aku" && text.shown < text.target.length) {
			text.shown = Math.min(text.target.length, text.shown + dt * (phase === "speaking" ? SPEAK_CPS : QUIET_CPS));
			paintText();
		}
		// Un nivel nuevo cada ~45 ms: tu micrófono, la voz simulada de Aku o un pulso suave al pensar.
		sample += dt;
		if (sample >= 0.045) {
			sample = 0;
			const t = now / 1000;
			const lvl =
				phase === "listening" || phase === "approval"
					? micLevel
					: phase === "speaking"
						? speechPulse(t)
						: phase === "thinking"
							? 0.06 + 0.05 * Math.sin(t * 6)
							: 0.02;
			levels.shift();
			levels.push(Math.min(1, lvl));
		}
		drawWave(ctx, canvas, levels, phase);
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);

	await loadSettings().catch(() => {});
	document.title = `${state.name} (voz)`;
	voice.open();
}

function drawWave(ctx, canvas, levels, phase) {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
	}
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);
	ctx.fillStyle = phase === "speaking" ? "#4aa3ff" : phase === "listening" || phase === "approval" ? "#e3221b" : "#6b6b72";
	const gap = 2;
	const bw = (w - gap * (levels.length - 1)) / levels.length;
	for (let i = 0; i < levels.length; i++) {
		// Las barras viejas (a la izquierda) se desvanecen un poco.
		ctx.globalAlpha = 0.35 + 0.65 * (i / (levels.length - 1));
		const bh = Math.max(3, levels[i] * (h - 4));
		const x = i * (bw + gap);
		const y = (h - bh) / 2;
		ctx.beginPath();
		ctx.roundRect(x, y, bw, bh, bw / 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
}
