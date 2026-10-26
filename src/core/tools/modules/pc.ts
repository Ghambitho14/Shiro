import type { ToolExecutor } from "../toolExecutors.js";
import { getState } from "../../../store.js";
import {
	clipboardAction,
	keyboardAction,
	mediaAction,
	mouseAction,
	openTarget,
	powerAction,
	processAction,
	systemInfo,
	takeScreenshot,
	windowAction,
	type MediaAction,
	type MouseAction,
	type PowerAction,
	type WindowAction,
} from "../../pc/pc.js";

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

const selfName = () => getState().name;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

export const executePcOpen = safe((a) => openTarget(String(a.target)));

export const executePcScreenshot = safe(async () => {
	const shot = await takeScreenshot();
	return {
		ok: true,
		content: `Captura de pantalla tomada (${shot.width}×${shot.height} px). Para pc_mouse usa coordenadas de esta imagen: (0,0) es la esquina superior izquierda.`,
		image: shot.path,
	};
});

export const executePcKeyboard = safe((a) => keyboardAction({ text: text(a.text), keys: text(a.keys), window: text(a.window) }, selfName()));

export const executePcMouse = safe((a) => mouseAction(a.action as MouseAction, num(a.x), num(a.y), num(a.amount)));

export const executePcMedia = safe((a) => mediaAction(a.action as MediaAction, num(a.value)));

export const executePcWindows = safe((a) => windowAction(a.action as WindowAction, text(a.title), selfName()));

export const executePcProcesses = safe((a) => processAction(a.action === "kill" ? "kill" : "list", text(a.name)));

export const executePcClipboard = safe((a) => clipboardAction(a.action === "write" ? "write" : "read", text(a.text)));

export const executePcSystem = safe(() => systemInfo());

export const executePcPower = safe((a) => powerAction(a.action as PowerAction, num(a.delay_minutes)));
