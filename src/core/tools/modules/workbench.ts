/** Tools del navegador de Shiro (`browser`) y de la terminal compartida (`terminal`). */
import type { ToolExecutor } from "../toolExecutors.js";
import { shiroBrowser } from "../../browser/browser.js";
import { terminal, TerminalSession } from "../../terminal/terminal.js";

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

export const executeTerminal = safe(async (a) => {
	switch (a.action) {
		case "run": {
			const seconds = num(a.timeout_seconds) ?? 60;
			const { block, finished } = await terminal.runAndWait(String(a.command ?? ""), "shiro", seconds * 1000);
			const out = tail(TerminalSession.outputOf(block)) || "(sin salida)";
			if (!finished) {
				return `El comando sigue ejecutándose (lleva ${seconds} s). Salida hasta ahora:\n${out}\n\nUsa terminal con action=read más tarde para ver cómo va, o action=stop para detenerlo.`;
			}
			const status = block.exitCode === 0 ? "terminó bien" : block.exitCode === null ? "se interrumpió" : `terminó con código ${block.exitCode}`;
			return `El comando ${status}. Carpeta actual: ${terminal.cwd}\n\n${out}`;
		}
		case "stop":
			return terminal.stop() ? "Detuve el comando que se estaba ejecutando (la terminal se reinició)." : "No había nada ejecutándose.";
		default:
			return terminal.readText(num(a.lines) ?? 80);
	}
});
