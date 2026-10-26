// Voz: leer en voz alta, dictado y el modo voz con la esfera.
import { setIcon } from "./icons.js";
import { toSpeechText } from "./markdown.js";
import { parseYesNo, Recognizer, SentenceSplitter, Speaker, voiceSupport } from "./voice.js";
import { HoloOrb } from "./orb.js";
import { $, closeMenu, el, prefs, toast, waitFor } from "./ui.js";
import { input, refs, state } from "./state.js";
import { agentOf } from "./messages.js";
import { autosize, paintComposer, sendMessage, stopGeneration } from "./chat.js";
import { loadSettings } from "./settings.js";

// ───────────────────────────── voz ─────────────────────────────

/** Cómo se lee en voz alta; con un agente, con su voz (si eligió una). */
export function ttsSettings(agent = null) {
	const v = state.settings?.voice;
	const av = (agent && (state.agents.find((a) => a.id === agent.id) || agent).voice) || {};
	return {
		engine: v?.ttsEngine === "server" && v.ttsBaseUrl ? "server" : "browser",
		voiceURI: av.browserVoiceURI || prefs.ttsVoice,
		rate: av.rate || prefs.ttsRate,
		lang: prefs.lang,
		serverVoice: av.serverVoice || "",
	};
}

export function sttEngine() {
	const v = state.settings?.voice;
	return v?.sttEngine === "server" && v.sttBaseUrl ? "server" : "browser";
}

export function canListen() {
	const sup = voiceSupport();
	return sttEngine() === "server" ? sup.recorder : sup.browserStt;
}

export const NO_STT = "Este navegador no reconoce voz. Abre Shiro en Edge o Chrome, o configura un servidor Whisper en Ajustes → Voz.";

// Leer un mensaje en voz alta
export const reader = { speaker: null, msg: null, btn: null };

export function stopReading() {
	const { speaker, btn } = reader;
	// Primero se limpia: stop() dispara onIdle, que vuelve a llamar aquí.
	Object.assign(reader, { speaker: null, msg: null, btn: null });
	speaker?.stop();
	if (btn) {
		setIcon(btn, "volume");
		btn.classList.remove("speaking");
	}
}

export function readAloud(m, btn) {
	if (reader.msg === m) return stopReading();
	stopReading();
	const sp = new Speaker(() => ttsSettings(agentOf(m)));
	sp.onError = (err) => toast(`La voz falló: ${err.message}`, "error");
	sp.onIdle = () => reader.speaker === sp && stopReading();
	const b = btn || refs.get(m)?.actions.querySelector('[data-icon="volume"]');
	Object.assign(reader, { speaker: sp, msg: m, btn: b });
	if (b) {
		setIcon(b, "pause");
		b.classList.add("speaking");
	}
	const splitter = new SentenceSplitter((s) => sp.speak(s));
	splitter.update(m.content);
	splitter.end(m.content);
	if (!sp.active) stopReading();
}

// Dictado en el cuadro de texto
export let dictation = null;

export async function toggleDictation() {
	if (dictation) return dictation.stop();
	if (!state.settings) await loadSettings().catch(() => {});
	if (!canListen()) return toast(NO_STT, "error", 7000);
	stopReading();
	const engine = sttEngine();
	const base = input.value;
	const sep = base && !/\s$/.test(base) ? " " : "";
	const btn = $("#dictate-btn");
	const hint = $("#dictate-hint");
	dictation = new Recognizer({
		engine,
		lang: prefs.lang,
		mode: "dictation",
		onInterim: (t) => {
			if (engine === "server") $("#dictate-text").textContent = t;
			else {
				input.value = base + sep + t;
				autosize();
			}
		},
	});
	btn.classList.add("recording");
	btn.title = "Terminar dictado";
	$("#dictate-text").textContent = "Escuchando… toca el micrófono para terminar";
	hint.classList.add("show");
	try {
		const text = await dictation.listen();
		input.value = text ? base + sep + text : base;
	} catch (err) {
		input.value = base;
		toast(err.message, "error", 7000);
	} finally {
		dictation = null;
		btn.classList.remove("recording");
		btn.title = "Dictar";
		hint.classList.remove("show");
		autosize();
		paintComposer();
		input.focus();
	}
}

// Modo voz (conversación manos libres)
export const orb = $("#orb");
export const sphere = new HoloOrb(orb);
export const voiceStatus = $("#voice-status");
export const voiceTranscript = $("#voice-transcript");
export const voiceApproval = $("#voice-approval");

export const voice = {
	active: false,
	muted: false,
	phase: "idle",
	rec: null,
	speaker: null,
	/** Agente que está hablando (en una sala): su voz y su nombre en el título. */
	agent: null,

	/** greet: texto que se dice al abrir (el saludo de un agente recién activado). */
	async open({ greet = "", agent = null } = {}) {
		if (this.active) return;
		if (!state.settings) await loadSettings().catch(() => {});
		if (!canListen()) return toast(NO_STT, "error", 7000);
		closeMenu();
		stopReading();
		if (dictation) dictation.cancel();
		this.active = true;
		this.muted = false;
		const lastAgent = [...state.messages].reverse().find((x) => x.role === "assistant");
		this.agent = agent || (state.room ? agentOf(lastAgent) || state.room.participants.find((p) => p.principal) || null : null);
		this.speaker = new Speaker(() => ttsSettings(this.agent));
		this.speaker.onStart = () => this.phase !== "approval" && this.set("speaking", "Hablando… toca el círculo para interrumpir");
		this.speaker.onError = (err) => toast(`La voz falló: ${err.message}`, "error", 6000);
		// Si termina de leer una frase y el modelo aún escribe, no dice "Hablando".
		this.speaker.onIdle = () => this.active && state.busy && this.phase === "speaking" && this.set("thinking", "Pensando…");
		this.paintTitle();
		voiceTranscript.textContent = "";
		voiceApproval.innerHTML = "";
		$("#voice-overlay").hidden = false;
		document.body.classList.add("voice-open");
		sphere.start();
		this.paintMute();
		if (greet) {
			voiceTranscript.textContent = greet;
			this.speaker.speak(greet);
			this.set("speaking", "Hablando… toca el círculo para interrumpir");
			this.speaker.drain().then(() => this.active && this.loop());
		} else this.loop();
	},

	paintTitle() {
		$("#voice-title").textContent = `Modo voz · ${this.agent?.name || state.name}`;
	},

	setAgent(agent) {
		this.agent = agent || null;
		if (this.active) this.paintTitle();
	},

	close() {
		if (!this.active) return;
		this.active = false;
		this.rec?.cancel();
		this.speaker?.stop();
		if (state.busy) stopGeneration();
		$("#voice-overlay").hidden = true;
		document.body.classList.remove("voice-open");
		sphere.stop();
		input.focus();
	},

	set(phase, text) {
		this.phase = phase;
		orb.dataset.state = phase;
		sphere.setState(phase);
		voiceStatus.textContent = text;
	},

	paintMute() {
		const b = $("#voice-mute");
		b.classList.toggle("muted", this.muted);
		setIcon(b, this.muted ? "micOff" : "mic");
		b.title = this.muted ? "Activar micrófono" : "Pausar micrófono";
	},

	toggleMute() {
		this.muted = !this.muted;
		if (this.muted) this.rec?.cancel();
		this.paintMute();
	},

	listenOnce() {
		this.rec = new Recognizer({
			engine: sttEngine(),
			lang: prefs.lang,
			mode: "turn",
			onInterim: (t) => (voiceTranscript.textContent = t),
			onLevel: (l) => sphere.setLevel(l),
		});
		return this.rec.listen().finally(() => {
			this.rec = null;
			sphere.setLevel(0);
		});
	},

	async loop() {
		while (this.active) {
			if (this.muted) {
				this.set("paused", "Micrófono en pausa · toca el círculo para hablar");
				await waitFor(() => !this.muted || !this.active);
				continue;
			}
			this.set("listening", "Te escucho…");
			let text = "";
			try {
				text = await this.listenOnce();
			} catch (err) {
				if (!this.active) break;
				this.set("idle", err.message);
				toast(err.message, "error", 8000);
				this.muted = true;
				this.paintMute();
				continue;
			}
			if (!this.active) break;
			if (!text || this.muted) continue;
			voiceTranscript.textContent = text;
			await this.respond(text);
		}
	},

	async respond(text) {
		this.set("thinking", "Pensando…");
		const splitter = new SentenceSplitter((s) => this.speaker.speak(s));
		await sendMessage(text, {
			voice: true,
			hooks: {
				onDelta: (full) => {
					splitter.update(full);
					const plain = toSpeechText(full);
					voiceTranscript.textContent = plain.length > 320 ? `…${plain.slice(-320)}` : plain;
				},
				onTool: (evt) => {
					if (evt.phase === "start" && this.phase !== "speaking") this.set("thinking", `${evt.label}…`);
				},
				onApproval: (evt, decide) => this.askApproval(evt, decide),
				// En una sala habla quien responde: su voz y su nombre.
				onAgent: (agent) => this.setAgent(agent),
				onDone: (m) => {
					if (m.error) this.speaker.speak(`Hubo un problema. ${m.error}`);
					else if (!m.stopped) splitter.end(m.content);
				},
			},
		});
		if (!this.active) return;
		await this.speaker.drain();
	},

	async askApproval(evt, decide) {
		if (!this.active) return;
		this.set("approval", "Necesito tu permiso");
		let settled = false;
		const card = el(
			"div",
			"approval",
			`<div class="approval-summary"></div><div class="approval-actions" style="justify-content:center"><button class="btn primary" data-a="yes">Sí, hazlo</button>${evt.canRemember ? '<button class="btn" data-a="always">Sí, siempre en este chat</button>' : ""}<button class="btn" data-a="no">No</button></div>`,
		);
		$(".approval-summary", card).textContent = evt.summary;
		voiceApproval.replaceChildren(card);
		const finish = (approved, remember = false) => {
			if (settled) return;
			settled = true;
			this.rec?.cancel();
			voiceApproval.innerHTML = "";
			decide(approved, remember);
			this.set("thinking", approved ? "Hecho, sigo…" : "Vale, no lo hago.");
		};
		card.onclick = (e) => {
			const a = e.target.closest("[data-a]")?.dataset.a;
			if (a) finish(a !== "no", a === "always");
		};
		this.speaker.speak(`Necesito tu permiso para: ${evt.summary}. ¿Lo hago?`);
		await this.speaker.drain();
		for (let tries = 0; tries < 2 && !settled && this.active; tries++) {
			this.set("approval", "¿Sí o no?");
			let answer = "";
			try {
				answer = await this.listenOnce();
			} catch {
				break;
			}
			if (settled) break;
			const yn = parseYesNo(answer);
			if (yn !== null) {
				finish(yn);
				break;
			}
			if (answer) {
				this.speaker.speak("No te entendí. ¿Sí o no?");
				await this.speaker.drain();
			}
		}
		if (!settled && this.active) this.set("approval", "Toca Sí o No");
	},

	tap() {
		if (this.phase === "speaking" || this.phase === "thinking") {
			this.speaker.stop();
			if (state.busy) stopGeneration();
		} else if (this.phase === "listening" || this.phase === "approval") {
			this.rec?.stop();
		} else if (this.muted || this.phase === "paused" || this.phase === "idle") {
			this.muted = false;
			this.paintMute();
		}
	},
};

/** Lo que antes se hacía al cargar la página (botones, eventos); app.js lo llama en orden. */
export function initVoice() {
	$("#dictate-btn").onclick = toggleDictation;
	$("#voice-btn").onclick = () => voice.open();
	orb.onclick = () => voice.tap();
	$("#voice-mute").onclick = () => voice.toggleMute();
	$("#voice-end").onclick = () => voice.close();
	$("#voice-close").onclick = () => voice.close();
}
