/**
 * Voz en el teléfono: dictado con el reconocimiento de voz de Android (expo-speech-recognition)
 * y lectura en voz alta con la voz del sistema (expo-speech). En el navegador usa la Web Speech API.
 */
import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { speakable } from "./core/text";

export type ListenHandlers = {
	/** Texto mientras habla (parcial) y al final (`final: true`). */
	onText: (text: string, final: boolean) => void;
	onEnd: () => void;
	onError: (message: string) => void;
};

const ERRORS: Record<string, string> = {
	"not-allowed": "Shiro no tiene permiso para usar el micrófono. Actívalo en los ajustes del teléfono.",
	"no-speech": "No te escuché. Prueba otra vez.",
	"speech-timeout": "No te escuché. Prueba otra vez.",
	network: "El reconocimiento de voz necesita internet.",
	"service-not-allowed": "Este teléfono no tiene reconocimiento de voz. Instala o activa la app de Google.",
	"language-not-supported": "El reconocimiento de voz no tiene el español instalado.",
};

let active: { remove: () => void }[] = [];

function clear() {
	for (const s of active) s.remove();
	active = [];
}

/** Empieza a escuchar (una frase). Devuelve false si no hay permiso. */
export async function startListening(h: ListenHandlers, lang = "es-ES"): Promise<boolean> {
	const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
	if (!perm.granted) {
		h.onError(ERRORS["not-allowed"]);
		return false;
	}
	clear();
	active = [
		ExpoSpeechRecognitionModule.addListener("result", (e) => h.onText(e.results[0]?.transcript ?? "", e.isFinal)),
		ExpoSpeechRecognitionModule.addListener("error", (e) => {
			// «aborted» es que lo paramos nosotros: no es un error para el usuario.
			if (e.error !== "aborted") h.onError(ERRORS[e.error] ?? `No pude escucharte (${e.message || e.error}).`);
		}),
		ExpoSpeechRecognitionModule.addListener("end", () => {
			clear();
			h.onEnd();
		}),
	];
	ExpoSpeechRecognitionModule.start({ lang, interimResults: true, continuous: false });
	return true;
}

export function stopListening(): void {
	try {
		ExpoSpeechRecognitionModule.stop();
	} catch {
		// ya estaba parado
	}
}

export function speak(text: string, h: { onDone?: () => void } = {}, lang = "es-ES"): void {
	Speech.stop();
	const clean = speakable(text);
	if (!clean) return h.onDone?.();
	Speech.speak(clean, { language: lang, onDone: h.onDone, onStopped: h.onDone, onError: () => h.onDone?.() });
}

export function stopSpeaking(): void {
	void Speech.stop();
}
