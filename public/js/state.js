// Estado compartido de la web (chats, mensajes, ajustes, sala) y los elementos principales.
import { $ } from "./ui.js";

// ───────────────────────────── estado ─────────────────────────────

export const state = {
	sessions: [],
	activeId: null,
	messages: [],
	busy: false,
	controller: null,
	attachments: [],
	settings: null,
	llm: null,
	profile: {},
	name: "Shiro",
	search: "",
	/** Id del proyecto cuya página está abierta (sin chat elegido): el próximo chat nace en él. */
	projectHome: null,
	/** "chat" o "projects" (la lista de proyectos). */
	view: "chat",
	placeholder: "",
	/** Agentes de Ajustes → Agentes (para nombres, colores y voces). */
	agents: [],
	/** Sala del chat abierto (participantes y principal), o null si es un chat normal. */
	room: null,
};

/** Referencias DOM de cada mensaje. */
export const refs = new WeakMap();

export const input = $("#input");
export const thread = $("#thread");
export const messagesBox = $("#messages");
