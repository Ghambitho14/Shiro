/**
 * Las listas de herramientas por perfil, modo y permiso, calculadas desde la `policy` de cada una
 * (`toolDefinitions.ts`). Antes eran listas escritas a mano en varios archivos: añadir una herramienta
 * obligaba a acordarse de todas. Ahora la herramienta dice lo suyo y las listas salen solas.
 *
 * Solo datos: lo importan approval.ts, untrusted.ts, chatMode.ts y toolIntent.ts sin crear ciclos.
 */
import { TOOLS, type IntentGroup, type ToolPolicy } from "./toolDefinitions.js";

const named = (pick: (p: ToolPolicy) => unknown): string[] => TOOLS.filter((t) => pick(t.policy)).map((t) => t.name);

/**
 * Perfil lite (Chat con modelos locales chicos): con menos opciones el modelo elige mejor y el prompt ocupa
 * menos. Lleva las tareas programadas (sin ellas solo podía crear recordatorios), `delegate` (si no, no sabía
 * que podía repartir tareas), `ask_user` y `draw`, y correo y calendario (solo con Google conectado, Agent.ts).
 */
export const LITE_TOOLS = named((p) => p.lite);

/** Herramientas que controlan el PC (se pueden desactivar todas con `pcControl: false`). */
export const PC_TOOLS = TOOLS.filter((t) => t.category === "pc").map((t) => t.name);

/** Solo funcionan en Windows (`requireWindows` en pc.ts): fuera de él el modelo ni las ve. pc_open y pc_system sí van en Linux y macOS. */
export const WINDOWS_ONLY_TOOLS = named((p) => p.windowsOnly);

/** Planear: investigar y proponer sin cambiar archivos, memoria, recordatorios ni ejecutar comandos (preguntar sí; dibujar no, escribe un archivo). */
export const PLAN_TOOLS = named((p) => p.plan === true);

/** Las herramientas de solo lectura al planear, según el modo. */
export function planToolsFor(mode: string): string[] {
	return mode === "hacking" ? named((p) => p.plan === true || p.plan === "hacking") : PLAN_TOOLS;
}

/**
 * Modo Hacking (pentesting autorizado), sin los controles generales del PC. La terminal es la clave: en la MV de
 * Kali es `bash`, con nmap, nikto, sqlmap… Lista elegida a propósito: no pasa por el perfil lite ni el modo ahorro.
 */
export const HACKING_TOOLS = named((p) => p.modes?.includes("hacking"));

/** Modo Code (programar en proyectos): las de Hacking sin las de seguridad. */
export const CODE_TOOLS = named((p) => p.modes?.includes("code"));

/** Lo único que «Automático» hace sin preguntar: comandos y archivos. */
export const AUTO_TOOLS = new Set(named((p) => p.auto));

/** Se puede permitir «para toda la conversación» (manejar el PC). Comandos, archivos y apagar se preguntan siempre. */
export const REMEMBERABLE_TOOLS = new Set(named((p) => p.remember));

/** Herramientas que traen texto de otros, con de dónde viene (para la marca de CONTENIDO EXTERNO). */
export const EXTERNAL_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(
	TOOLS.filter((t) => t.policy.external).map((t) => [t.name, t.policy.external as string]),
);

/** Tareas programadas `agent`: nada con efectos fuera de leer. */
export const SCHEDULED_TOOLS = named((p) => p.scheduled);

/** Modo ahorro: las que se ofrecen siempre. */
export const ALWAYS_TOOLS = named((p) => p.intent === "always");

/** Modo ahorro: las de un grupo. */
export function toolsInGroup(group: IntentGroup): string[] {
	return named((p) => p.intent === group);
}

const byName = new Map(TOOLS.map((t) => [t.name, t.policy]));

/** Al planear, si esta llamada solo lee (las que no declaran `planActions` leen siempre). */
export function isPlanAction(name: string, action: unknown): boolean {
	const p = byName.get(name);
	if (!p?.planActions) return true;
	return p.planActions.includes(String(action ?? p.defaultAction));
}

/** Acciones que preguntan siempre, sea cual sea el permiso del chat (`alwaysAsk`). */
export function asksAlways(name: string, action: unknown): boolean {
	return byName.get(name)?.alwaysAsk?.includes(String(action)) === true;
}
