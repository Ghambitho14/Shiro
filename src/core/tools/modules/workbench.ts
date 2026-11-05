/** Tools del navegador de Shiro (`browser`) y de la terminal compartida (`terminal`). */
import type { ToolExecutor } from "../toolExecutors.js";
import { shiroBrowser } from "../../browser/browser.js";
import { currentAgentRun } from "../../agent/runContext.js";
import { terminal, type TermOutcome } from "../../terminal/terminal.js";

type Result = Awaited<ReturnType<ToolExecutor>>;

/** Convierte cualquier fallo en un resultado legible (el modelo lo verá y podrá explicarlo). */
function safe(fn: (args: Record<string, unknown>) => Promise<string | Result>): ToolExecutor {
	return async (args) => {
		try {
			const r = await fn(args);
			return typeof r === "string" ? { ok: true, content: r } : r;
		} catch (err) {
			return { ok: false, content: err instanceof Error ? err.message : String(err) };
		}
	};
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export const executeBrowser = safe(async (a) => {
	switch (a.action) {
		case "open":
			return shiroBrowser.open(String(a.url ?? ""));
		case "read":
			return shiroBrowser.snapshot();
		case "click":
			return shiroBrowser.click(num(a.ref)!);
		case "type":
			return shiroBrowser.type(num(a.ref)!, typeof a.text === "string" ? a.text : "", a.enter === true);
		case "scroll":
			return shiroBrowser.scroll(a.direction === "up" ? "up" : "down");
		case "back":
			return shiroBrowser.back();
		case "screenshot": {
			const shot = await shiroBrowser.screenshot();
			return { ok: true, content: `Captura del navegador (${shot.width}×${shot.height} px): ${shiroBrowser.state.url}`, image: shot.path };
		}
		case "close":
			await shiroBrowser.close();
			return "Navegador cerrado.";
		default:
			return { ok: false, content: `Acción desconocida: ${String(a.action)}` };
	}
});

/** Final de la salida (lo más reciente es lo que importa). */
function tail(text: string, max = 6000): string {
	const t = text.replace(/\n+$/, "");
	return t.length > max ? "…" + t.slice(-max) : t;
}

/** Qué decirle al modelo cuando el programa no ha terminado. */
function pendingText(outcome: TermOutcome, seconds: number): string {
	switch (outcome) {
		case "input":
			return "El programa sigue abierto y parece esperar algo. Usa action=write para responderle, action=read para volver a mirar o action=stop para cerrarlo.";
		case "password":
			return "El programa pide una contraseña y el usuario no la ha escrito. Pídele que la escriba en el panel Terminal (no en el chat) y mira luego con action=read.";
		case "aborted":
			return "El usuario detuvo la respuesta; lo que estaba en la terminal sigue abierto.";
		default:
			return `Sigue en marcha (lleva ${seconds} s). Usa action=read con wait_seconds para esperar y ver cómo va, o action=stop para detenerlo.`;
	}
}

export const executeTerminal = safe(async (a) => {
	const signal = currentAgentRun()?.signal;
	switch (a.action) {
		case "run": {
			const seconds = num(a.timeout_seconds) ?? 60;
			const r = await terminal.runAndWait(String(a.command ?? ""), { timeoutMs: seconds * 1000, signal });
			const out = tail(r.output) || "(sin salida)";
			if (r.outcome !== "finished") return `${pendingText(r.outcome, seconds)}\n\nEn pantalla:\n${out}`;
			const status = r.exitCode === 0 ? "terminó bien" : r.exitCode === null ? "se interrumpió" : `terminó con código ${r.exitCode}`;
			return `El comando ${status}. Carpeta actual: ${r.cwd}\n\n${out}`;
		}
		case "write": {
			const seconds = num(a.timeout_seconds) ?? 15;
			const text = typeof a.text === "string" ? a.text : "";
			const keys = typeof a.keys === "string" ? a.keys : "";
			// Con texto se pulsa Enter salvo que se pida lo contrario; con teclas sueltas, solo esas teclas.
			const enter = typeof a.enter === "boolean" ? a.enter : Boolean(text);
			const outcome = await terminal.write({ text, enter, keys, timeoutMs: seconds * 1000, signal });
			const state = outcome === "finished" ? "Volvió al prompt." : pendingText(outcome, seconds);
			return `Escribí en la terminal. ${state}\n\nEn pantalla:\n${terminal.tail()}`;
		}
		case "stop": {
			if (!terminal.stop()) return "No había nada ejecutándose.";
			await terminal.whenIdle(3000);
			return `Detuve lo que se estaba ejecutando.\n\nEn pantalla:\n${terminal.tail(20)}`;
		}
		default: {
			const wait = num(a.wait_seconds);
			if (wait && terminal.isRunning()) await terminal.watch(wait * 1000, signal);
			return terminal.readText(num(a.lines) ?? 80);
		}
	}
});
