// Voz: reconocer lo que dices (navegador o servidor Whisper) y leer respuestas (navegador o servidor TTS).

import { authFetch } from "./api.js";
import { toSpeechText } from "./markdown.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function voiceSupport() {
	return {
		browserStt: Boolean(SR),
		recorder: Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
		browserTts: "speechSynthesis" in window,
	};
}

export class VoiceError extends Error {}

const BROWSER_ERRORS = {
	"not-allowed": "No tengo permiso para usar el micrófono. Actívalo en el candado de la barra de direcciones.",
	"service-not-allowed": "El navegador no permite el reconocimiento de voz aquí. Prueba con Edge o Chrome, o usa un servidor Whisper (Ajustes → Voz).",
	"audio-capture": "No encuentro ningún micrófono conectado.",
	network: "El reconocimiento de voz del navegador necesita internet. Sin conexión, configura un servidor Whisper local en Ajustes → Voz.",
	"language-not-supported": "El navegador no reconoce ese idioma. Cambia el idioma en Ajustes → Voz.",
};

/** Nivel del micrófono (0-1) para animar la interfaz. */
async function openMeter(onLevel) {
	const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
	const ctx = new AudioContext();
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 2048;
	ctx.createMediaStreamSource(stream).connect(analyser);
	const data = new Float32Array(analyser.fftSize);
	const read = () => {
		analyser.getFloatTimeDomainData(data);
		let sum = 0;
		for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
		return Math.sqrt(sum / data.length);
	};
	let raf = 0;
	const loop = () => {
		onLevel?.(Math.min(1, read() * 9));
		raf = requestAnimationFrame(loop);
	};
	if (onLevel) loop();
	return {
		stream,
		rms: read,
		close() {
			cancelAnimationFrame(raf);
			stream.getTracks().forEach((t) => t.stop());
			ctx.close().catch(() => {});
			onLevel?.(0);
		},
	};
}

/**
 * Escucha una frase (mode "turn": termina solo tras una pausa) o un dictado largo
 * (mode "dictation": sigue hasta stop()). listen() devuelve el texto reconocido.
 */
export class Recognizer {
	constructor({ engine = "browser", lang = "es-ES", mode = "turn", onInterim, onLevel } = {}) {
		this.engine = engine;
		this.lang = lang;
		this.mode = mode;
		this.onInterim = onInterim;
		this.onLevel = onLevel;
		this.cancelled = false;
		this._stop = () => {};
	}

	listen() {
		return this.engine === "server" ? this.#listenServer() : this.#listenBrowser();
	}

	/** Termina ya y devuelve lo que se haya oído. */
	stop() {
		this._stop();
	}

	/** Termina sin devolver nada. */
	cancel() {
		this.cancelled = true;
		this._stop();
	}

	async #listenBrowser() {
		if (!SR) throw new VoiceError("Este navegador no reconoce voz. Usa Edge o Chrome, o configura un servidor Whisper en Ajustes → Voz.");
		let meter = null;
		try {
			meter = await openMeter(this.onLevel);
		} catch (err) {
			if (err?.name === "NotAllowedError") throw new VoiceError(BROWSER_ERRORS["not-allowed"]);
			if (err?.name === "NotFoundError") throw new VoiceError(BROWSER_ERRORS["audio-capture"]);
		}
		return new Promise((resolve, reject) => {
			const rec = new SR();
			rec.lang = this.lang;
			rec.interimResults = true;
			rec.continuous = this.mode === "dictation";
			rec.maxAlternatives = 1;
			let finalText = "";
			let interim = "";
			let error = "";
			rec.onresult = (e) => {
				interim = "";
				for (let i = e.resultIndex; i < e.results.length; i++) {
					const r = e.results[i];
					if (r.isFinal) finalText += r[0].transcript;
					else interim += r[0].transcript;
				}
				this.onInterim?.(`${finalText} ${interim}`.trim());
			};
			rec.onerror = (e) => {
				error = e.error;
			};
			rec.onend = () => {
				meter?.close();
				if (this.cancelled) return resolve("");
				if (error && error !== "no-speech" && error !== "aborted") {
					return reject(new VoiceError(BROWSER_ERRORS[error] || `Error de reconocimiento de voz (${error}).`));
				}
				resolve(`${finalText} ${interim}`.replace(/\s+/g, " ").trim());
			};
			this._stop = () => {
				try {
					this.cancelled ? rec.abort() : rec.stop();
				} catch {}
			};
			try {
				rec.start();
			} catch (err) {
				meter?.close();
				reject(new VoiceError("No pude empezar a escuchar: " + (err?.message || err)));
			}
		});
	}

	async #listenServer() {
		if (!voiceSupport().recorder) throw new VoiceError("Este navegador no puede grabar audio.");
		let meter;
		try {
			meter = await openMeter(this.onLevel);
		} catch (err) {
			if (err?.name === "NotFoundError") throw new VoiceError(BROWSER_ERRORS["audio-capture"]);
			throw new VoiceError(BROWSER_ERRORS["not-allowed"]);
		}
		const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
		const recorder = new MediaRecorder(meter.stream, mime ? { mimeType: mime } : undefined);
		const chunks = [];
		recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
		const stopped = new Promise((r) => (recorder.onstop = r));
		recorder.start(250);

		// Detección de voz simple: se calibra el ruido y se corta tras un silencio.
		const dictation = this.mode === "dictation";
		const started = Date.now();
		let noise = 0.01;
		let calibrate = 8;
		let speechMs = 0;
		let silenceMs = 0;
		let heard = false;

		const text = await new Promise((resolve) => {
			let done = false;
			const finish = async (keep) => {
				if (done) return;
				done = true;
				clearInterval(timer);
				recorder.stop();
				await stopped;
				meter.close();
				if (!keep || this.cancelled || !heard) return resolve("");
				this.onInterim?.("Transcribiendo…");
				try {
					const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
					const r = await authFetch(`/api/voice/transcribe?lang=${encodeURIComponent(this.lang)}`, {
						method: "POST",
						headers: { "Content-Type": blob.type },
						body: blob,
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) throw new VoiceError(j.error || `Error ${r.status}`);
					resolve(String(j.text || "").trim());
				} catch (err) {
					this.error = err;
					resolve("");
				}
			};
			this._stop = () => finish(!this.cancelled);
			const timer = setInterval(() => {
				const rms = meter.rms();
				if (calibrate > 0) {
					noise = noise * 0.6 + rms * 0.4;
					calibrate--;
					return;
				}
				const threshold = Math.max(0.012, noise * 2.6);
				if (rms > threshold) {
					speechMs += 50;
					silenceMs = 0;
					if (speechMs >= 200) heard = true;
				} else {
					silenceMs += 50;
					if (!heard) noise = noise * 0.97 + rms * 0.03;
				}
				const elapsed = Date.now() - started;
				if (heard && silenceMs >= (dictation ? 2600 : 1100)) finish(true);
				else if (!heard && elapsed > (dictation ? 20000 : 10000)) finish(false);
				else if (elapsed > 90000) finish(true);
			}, 50);
		});
		if (this.error) throw this.error;
		return text;
	}
}

// ─────────────────────────── Lectura en voz alta ───────────────────────────

export function listVoices() {
	return "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
}

/** Elige una voz: la guardada, o la mejor del idioma (las "Natural"/"Online" de Edge suenan mejor). */
export function pickVoice(voiceURI, lang) {
	const voices = listVoices();
	if (voiceURI) {
		const v = voices.find((x) => x.voiceURI === voiceURI);
		if (v) return v;
	}
	const base = (lang || "es").slice(0, 2).toLowerCase();
	const score = (v) => {
		let s = 0;
		if (v.lang?.toLowerCase() === (lang || "").toLowerCase()) s += 4;
		if (v.lang?.toLowerCase().startsWith(base)) s += 10;
		if (/natural|online|neural/i.test(v.name)) s += 3;
		if (/google/i.test(v.name)) s += 1;
		return s;
	};
	return [...voices].sort((a, b) => score(b) - score(a))[0] || null;
}

/**
 * Cola de frases para leer en voz alta, en orden. Con motor "server" las frases se
 * piden por adelantado para que no haya pausas entre ellas.
 */
export class Speaker {
	constructor(getSettings) {
		this.getSettings = getSettings;
		this.queue = [];
		this.busy = false;
		this.generation = 0;
		this.waiters = [];
		this.onStart = null;
		this.onIdle = null;
		this.audio = null;
		this.keep = [];
	}

	get active() {
		return this.busy || this.queue.length > 0;
	}

	speak(text) {
		const clean = toSpeechText(text);
		if (!clean) return;
		const s = this.getSettings();
		const item = { text: clean, settings: s };
		if (s.engine === "server") {
			item.audio = this.#fetchAudio(clean, s);
			item.audio.catch(() => {}); // el error se trata al reproducir
		}
		this.queue.push(item);
		if (!this.busy) this.#next(this.generation);
	}

	/** Espera a que termine de hablar todo lo encolado. */
	drain() {
		if (!this.active) return Promise.resolve();
		return new Promise((r) => this.waiters.push(r));
	}

	stop() {
		this.generation++;
		this.queue = [];
		this.busy = false;
		if ("speechSynthesis" in window) window.speechSynthesis.cancel();
		if (this.audio) {
			this.audio.pause();
			this.audio = null;
		}
		this.#idle();
	}

	#idle() {
		const waiters = this.waiters.splice(0);
		waiters.forEach((r) => r());
		this.onIdle?.();
	}

	async #fetchAudio(text, s) {
		const r = await authFetch("/api/voice/speak", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// En una sala cada agente puede tener su voz del servidor.
			body: JSON.stringify({ text, speed: s.rate, ...(s.serverVoice ? { voice: s.serverVoice } : {}) }),
		});
		if (!r.ok) {
			const j = await r.json().catch(() => ({}));
			throw new Error(j.error || `Error ${r.status}`);
		}
		return URL.createObjectURL(await r.blob());
	}

	async #next(gen) {
		if (gen !== this.generation) return;
		const item = this.queue.shift();
		if (!item) {
			this.busy = false;
			this.#idle();
			return;
		}
		if (!this.busy) {
			this.busy = true;
			this.onStart?.();
		}
		try {
			if (item.audio) await this.#playServer(item, gen);
			else await this.#playBrowser(item);
		} catch (err) {
			console.warn("Voz:", err);
			this.onError?.(err);
		}
		this.#next(gen);
	}

	#playBrowser(item) {
		return new Promise((resolve) => {
			if (!("speechSynthesis" in window)) return resolve();
			const u = new SpeechSynthesisUtterance(item.text);
			const voice = pickVoice(item.settings.voiceURI, item.settings.lang);
			if (voice) u.voice = voice;
			u.lang = voice?.lang || item.settings.lang || "es-ES";
			u.rate = item.settings.rate || 1;
			u.onend = u.onerror = () => {
				this.keep = this.keep.filter((x) => x !== u);
				resolve();
			};
			// Chrome pierde el evento onend si el objeto se recolecta: se guarda una referencia.
			this.keep.push(u);
			window.speechSynthesis.speak(u);
		});
	}

	async #playServer(item, gen) {
		const url = await item.audio;
		if (gen !== this.generation) return;
		await new Promise((resolve) => {
			const a = new Audio(url);
			this.audio = a;
			a.onended = a.onerror = () => resolve();
			a.play().catch(() => resolve());
		});
		URL.revokeObjectURL(url);
	}
}

// ─────────────────────────── Dividir en frases mientras llega el texto ───────────────────────────

/**
 * Recibe el texto completo según va llegando y entrega frases terminadas para leerlas
 * cuanto antes. Se salta los bloques de código (y avisa una vez al final).
 */
export class SentenceSplitter {
	constructor(onSentence) {
		this.onSentence = onSentence;
		this.consumed = 0;
		this.inCode = false;
		this.skippedCode = false;
		this.pending = "";
	}

	update(full) {
		if (full.length < this.consumed) return;
		const fresh = full.slice(this.consumed);
		// Último final de frase completo (seguido de espacio o salto).
		let cut = -1;
		const re = /[.!?…:;](?=\s)|\n/g;
		let m;
		while ((m = re.exec(fresh))) cut = m.index + m[0].length;
		if (cut < 0) {
			if (fresh.length > 260) {
				const comma = fresh.lastIndexOf(", ", 240);
				if (comma > 40) cut = comma + 1;
			}
			if (cut < 0) return;
		}
		this.consumed += cut;
		this.#take(fresh.slice(0, cut), false);
	}

	end(full) {
		if (typeof full === "string") {
			if (full.length >= this.consumed) this.#take(full.slice(this.consumed), true);
			this.consumed = full.length;
		} else {
			this.#take("", true);
		}
		if (this.skippedCode) this.onSentence("Te dejé el código en la pantalla.");
	}

	#take(chunk, final) {
		const parts = chunk.split("```");
		let text = "";
		parts.forEach((p, i) => {
			if (i > 0) this.inCode = !this.inCode;
			if (this.inCode) {
				if (p.trim()) this.skippedCode = true;
			} else {
				text += p;
			}
		});
		this.pending += text;
		const clean = toSpeechText(this.pending);
		// Frases muy cortas se juntan con la siguiente (suena más natural).
		if (clean.length >= 18 || (final && clean)) {
			this.onSentence(clean);
			this.pending = "";
		}
	}
}

/** Interpreta un "sí" o un "no" dicho en voz alta. null si no queda claro. */
export function parseYesNo(text) {
	const t = String(text || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.trim();
	if (!t) return null;
	if (/^(no|nop|nel|negativo)\b|\b(no lo hagas|mejor no|para nada|ni hablar|cancela|cancelar|rechaza|rechazar|detente)\b/.test(t)) return false;
	if (/\b(si|claro|dale|ok|okay|vale|adelante|hazlo|permitir|permito|permitelo|de acuerdo|por supuesto|venga|afirmativo|yes|sure)\b/.test(t)) return true;
	return null;
}
