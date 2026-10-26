import type { Message } from "./Types.js";
import { getSoul, renderSystemPrompt, withAbilities } from "../soul/soul.js";
import { buildSkillsBlock, type Skill } from "../skills/SkillLoader.js";
import { getConfig } from "../../config/config.js";

export type UserProfileInput = {
	userName?: string;
	language?: string;
	about?: string;
	extra?: string;
};

export type ContextInput = {
	goal: string;
	agentName: string;
	tokenBudget: number;
	workspaceContext?: string;
	/** Si true, no se incluyen herramientas en el contexto (solo respuesta en texto). */
	textOnly?: boolean;
	/** Perfil del usuario para personalizar respuestas (nombre, idioma, sobre ti). */
	userProfile?: UserProfileInput | null;
	/** El modelo tiene herramientas para controlar el PC. */
	pcControl?: boolean;
	/** El modelo puede ver imágenes (capturas de pantalla). */
	vision?: boolean;
	/** El usuario habla por voz: la respuesta se leerá en voz alta. */
	voice?: boolean;
	/** Habilidades activas (el modelo tiene use_skill). Se listan con su descripción. */
	skills?: Skill[];
	/** Habilidad pedida con "/nombre": sus instrucciones completas. */
	forcedSkill?: { name: string; body: string };
	/** Proyecto del chat: instrucciones, lista de archivos y, si es pequeño, su contenido. */
	project?: ProjectContext;
	/** Forma de ser del agente de una sala. */
	persona?: PersonaContext;
	/** Sala con varios agentes. */
	room?: RoomContext;
};

export type PersonaContext = {
	/** Texto del usuario; admite {{nombre}}, {{usuario}}, {{carpeta}} y {{fecha}}. */
	prompt: string;
	/** true: reemplaza las instrucciones base. false: se añade como "Tu papel". */
	replace: boolean;
};

export type RoomContext = {
	/** Nombre del agente que responde ahora. */
	self: string;
	participants: { name: string; description?: string; principal: boolean }[];
	/** Mensajes viejos que no se le pasan por falta de espacio. */
	omitted: number;
};

export function buildRoomBlock(r: RoomContext): string {
	const who = r.participants
		.map((p) => `${p.name}${p.principal ? " (principal)" : ""}${p.description ? `: ${p.description}` : ""}`)
		.join("; ");
	const lines = [
		"## Sala",
		`Estás en una conversación con el usuario y otros agentes. Participan: ${who}.`,
		"Los mensajes de los demás te llegan como «[Nombre]: …» y los del usuario como «[Usuario]: …» cuando van juntos.",
		`Responde solo como ${r.self}: no hables por los demás ni pongas tu nombre delante de tu respuesta.`,
	];
	if (r.omitted > 0) lines.push(`(Se omitieron ${r.omitted} mensajes anteriores de la sala por falta de espacio.)`);
	return lines.join("\n");
}

export type ProjectContext = {
	name: string;
	description?: string;
	instructions?: string;
	/** Lista corta de archivos (una línea por archivo). */
	index: string;
	/** Texto completo de los archivos si cabe; si no, null. */
	inline?: string | null;
	/** El modelo tiene la tool project. */
	hasTool: boolean;
};

export function buildProjectBlock(p: ProjectContext, maxChars: number): string {
	const parts = [`## Proyecto «${p.name}»`, `Este chat es parte del proyecto «${p.name}»${p.description ? `: ${p.description}` : "."}`];
	if (p.instructions) parts.push(`### Instrucciones del proyecto (síguelas en todas tus respuestas)\n${p.instructions}`);
	parts.push(`### Archivos del proyecto\n${p.index}`);
	if (p.hasTool) {
		parts.push(
			"Para saber qué dicen los archivos usa la tool project (action=search para buscar, action=read para leer) antes de responder sobre su contenido. Di de qué archivo sacas cada dato y no inventes lo que no hayas leído.",
		);
	}
	let block = parts.join("\n\n");
	if (p.inline && block.length + p.inline.length + 40 <= maxChars) block += `\n\n### Contenido de los archivos\n${p.inline}`;
	return block.length > maxChars ? block.slice(0, maxChars) + "\n…(recortado)" : block;
}

function osName(): string {
	if (process.platform === "win32") return "Windows";
	if (process.platform === "darwin") return "macOS";
	return "Linux";
}

export function buildPcControlBlock(vision: boolean): string {
	return `## Control del PC
Puedes manejar el PC del usuario (${osName()}) con las herramientas pc_*:
- Abrir apps, webs, carpetas o archivos: pc_open. Para poner música o vídeos abre la búsqueda en YouTube o Spotify.
- Volumen y música: pc_media. Ventanas: pc_windows. Estado del equipo: pc_system.
- Escribir o pulsar teclas: pc_keyboard, indicando siempre la ventana ("window") para no escribir en el sitio equivocado.
- ${vision ? "Para ver la pantalla usa pc_screenshot; para hacer clic, pc_mouse con coordenadas de esa captura." : "Tu modelo no ve imágenes: para saber qué hay abierto usa pc_windows (action=list)."}
- Tienes tu propio navegador (tool browser, el usuario lo ve en el panel "Navegador"). Úsalo si el usuario dice "tu navegador" o "en el panel", o cuando tengas que hacer algo tú en una web (buscar, leer, rellenar formularios). Empieza con action=open; la respuesta trae la página con elementos numerados [n]: usa ese número como ref en click o type. pc_open abre las webs en el navegador normal del usuario: úsalo para música o vídeos que quiere ver u oír él.
- Terminal compartida con el usuario (tool terminal, panel "Terminal"): action=read para ver lo que hay en ella (lo que el usuario ejecutó y su salida); action=run para ejecutar un comando a su vista.
- Haz la acción directamente y confirma en una frase lo que hiciste. Si algo falla, explica qué pasó.
- Nunca apagues, reinicies ni cierres programas a la fuerza si el usuario no lo pidió claramente.`;
}

export const VOICE_BLOCK = `## Modo voz
El usuario te habla por voz y tu respuesta se leerá en voz alta:
- Responde en 1 a 3 frases cortas y naturales, como en una conversación.
- Sin markdown, listas, tablas, emojis, enlaces ni bloques de código.
- Si la respuesta sería larga, da lo esencial y ofrece ampliar.`;

/** Espacio para SOUL.md, TOOLS.md y la memoria (Ajustes → Personalización avisa si se pasan). */
export const WORKSPACE_MAX_CHARS = 8000;

/**
 * Prioridad: SOUL > perfil > proyecto > workspace (con la memoria) > skills. La conversación va aparte, como mensajes.
 * Las herramientas no se listan aquí: van por la API del modelo (o por textTools en modo texto),
 * así no se envían dos veces y se ahorra contexto en modelos locales.
 */
export function buildContext(input: ContextInput): { system: string; messages: Message[] } {
	const approxCharsPerToken = 4;
	const budgetChars = Math.floor(input.tokenBudget * approxCharsPerToken);

	const textOnly = input.textOnly === true;
	const persona = input.persona?.prompt.trim() ? input.persona : undefined;
	const soul = persona?.replace
		? withAbilities(renderSystemPrompt(persona.prompt.trim(), input.agentName))
		: getSoul(input.agentName, textOnly) +
			(persona ? `\n\n## Tu papel\n${renderSystemPrompt(persona.prompt.trim(), input.agentName)}` : "");
	const roomBlock = input.room ? "\n\n" + buildRoomBlock(input.room) : "";
	const pcBlock = input.pcControl && !textOnly ? "\n\n" + buildPcControlBlock(input.vision === true) : "";
	const voiceBlock = input.voice ? "\n\n" + VOICE_BLOCK : "";

	let remaining = budgetChars - soul.length - roomBlock.length - pcBlock.length - voiceBlock.length - 200;
	if (remaining < 500) remaining = 500;

	const userBlock = input.userProfile && (input.userProfile.userName || input.userProfile.about || input.userProfile.language || input.userProfile.extra)
		? (() => {
				const p = input.userProfile!;
				const parts: string[] = [];
				if (p.userName) parts.push("Nombre: " + p.userName);
				if (p.language) parts.push("Idioma preferido: " + p.language);
				if (p.about) parts.push("Sobre la persona: " + p.about);
				if (p.extra) parts.push("Notas: " + p.extra);
				const text = "## Sobre el usuario\n" + parts.join("\n");
				remaining -= text.length;
				return "\n\n" + text;
			})()
		: "";
	let projectBlock = "";
	if (input.project) {
		projectBlock = buildProjectBlock(input.project, Math.max(1500, Math.min(remaining - 1500, 12000)));
		remaining -= projectBlock.length;
	}
	const workspaceBlock = input.workspaceContext
		? `## Contexto workspace\n${input.workspaceContext.slice(0, Math.min(remaining, WORKSPACE_MAX_CHARS))}`
		: "";
	if (workspaceBlock) remaining -= workspaceBlock.length;

	let forcedBlock = "";
	if (input.forcedSkill) {
		const max = Math.max(2000, remaining - 2500);
		const body = input.forcedSkill.body;
		const clipped = body.length > max ? body.slice(0, max) + "\n…(recortado: lee el resto con use_skill)" : body;
		forcedBlock = `## Habilidad "${input.forcedSkill.name}" (la pidió el usuario)\nSigue estas instrucciones para responder a su mensaje (ya las tienes aquí: no hace falta cargarla con use_skill):\n\n${clipped}`;
		remaining -= forcedBlock.length;
	}

	const skillsBlock =
		input.skills?.length && !textOnly
			? buildSkillsBlock(input.goal, Math.max(800, Math.min(remaining, getConfig().skillsMaxChars)), input.skills)
			: "";
	const system =
		soul +
		roomBlock +
		pcBlock +
		voiceBlock +
		userBlock +
		(projectBlock ? "\n\n" + projectBlock : "") +
		(workspaceBlock ? "\n\n" + workspaceBlock : "") +
		(skillsBlock ? "\n\n" + skillsBlock : "") +
		(forcedBlock ? "\n\n" + forcedBlock : "");

	// Conversación simple: solo el mensaje del usuario. Modo acción: el goal tal cual.
	const userContent = input.goal;
	const messages: Message[] = [{ role: "user", content: userContent }];
	return { system, messages };
}
