/** Modos del chat web. El servidor los valida: nunca se fía de un texto libre del navegador. */
export const CHAT_MODES = ["chat", "code", "hacking"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];

/** Chat normal, Code (programar) y Hacking (pentesting autorizado; el id sigue siendo `hacking`). */
export function parseChatMode(value: unknown): ChatMode {
	return typeof value === "string" && (CHAT_MODES as readonly string[]).includes(value) ? (value as ChatMode) : "chat";
}

/**
 * Cómo trabaja el agente en cualquier modo (botón de la caja de escribir): pregunta cada acción delicada,
 * solo lee y propone un plan, pregunta solo lo peligroso o no pregunta nada (`requestApproval` en approval.ts).
 */
export const PERMISSION_MODES = ["ask", "plan", "auto", "bypass"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function parsePermissionMode(value: unknown): PermissionMode {
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value) ? (value as PermissionMode) : "ask";
}

/**
 * Al planear, algunas herramientas de lectura tienen también acciones con efectos. La lista de tools
 * no basta: esta comprobación se hace otra vez justo antes de ejecutar cada llamada.
 */
export function isPlanToolCall(name: string, args: Record<string, unknown>): boolean {
	if (name === "project") return ["list", "find", "read", "search"].includes(String(args.action ?? "list"));
	if (name === "terminal") return args.action === "read";
	if (name === "browser") return ["open", "read", "scroll", "back", "screenshot"].includes(String(args.action));
	return true;
}
