/**
 * Comandos del chat del móvil (el menú que sale al escribir «/», como src/commands.ts del PC).
 * Solo los que tienen sentido aquí: lo del PC (habilidades, MCP, agentes…) no está.
 */
export type MobileCommand = { name: string; aliases: string[]; usage?: string; description: string };

export const MOBILE_COMMANDS: MobileCommand[] = [
	{ name: "ayuda", aliases: ["help"], description: "Lista de comandos" },
	{ name: "nuevo", aliases: ["new", "limpiar", "clear", "reset"], description: "Empezar una conversación nueva" },
	{ name: "modelo", aliases: ["model"], usage: "/modelo [nombre]", description: "Ver el modelo o cambiarlo" },
	{ name: "recordatorios", aliases: ["reminders"], description: "Abrir tus recordatorios" },
	{ name: "voz", aliases: ["voice"], description: "Hablar con el asistente (modo voz)" },
	{ name: "ajustes", aliases: ["settings"], description: "Abrir Ajustes" },
];

/** Los comandos que empiezan por lo escrito (para el menú). Vacío si no empieza por «/» o ya hay un espacio. */
export function matchCommands(input: string): MobileCommand[] {
	const m = /^\/(\S*)$/.exec(input.trimStart());
	if (!m) return [];
	const q = m[1].toLowerCase();
	return MOBILE_COMMANDS.filter((c) => c.name.startsWith(q) || c.aliases.some((a) => a.startsWith(q)));
}

/** «/modelo qwen3» → { command: "modelo", arg: "qwen3" }. null si no es un comando conocido. */
export function parseCommand(text: string): { command: string; arg: string } | null {
	const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
	if (!m) return null;
	const word = m[1].toLowerCase();
	const cmd = MOBILE_COMMANDS.find((c) => c.name === word || c.aliases.includes(word));
	return cmd ? { command: cmd.name, arg: m[2].trim() } : null;
}

export function helpText(): string {
	return ["**Comandos**", ...MOBILE_COMMANDS.map((c) => `- \`${c.usage ?? "/" + c.name}\` — ${c.description}`)].join("\n");
}
