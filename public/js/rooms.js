// Salas con varios agentes: barra de participantes, órdenes, regenerar y editar.
import { icon } from "./icons.js";
import { api } from "./api.js";
import { agentAvatar, loadAgents } from "./agents.js";
import { $, el, openMenu, toast } from "./ui.js";
import { refs, state } from "./state.js";
import { buildUser, contentParts, renderThread, replaceText, serialize } from "./messages.js";
import { ensureSession, runAssistant } from "./chat.js";
import { openChat, paintSidebar, setDocTitle, upsertSession } from "./sidebar.js";
import { settingsDlg } from "./settings.js";
import { voice } from "./voiceMode.js";

// ───────────────────────────── salas con varios agentes ─────────────────────────────

export const roomBar = $("#room-bar");

export function setRoom(room) {
	state.room = room || null;
	paintRoomBar();
}

export async function loadRoom(id) {
	try {
		const d = await api(`/api/rooms/${encodeURIComponent(id)}`);
		if (state.activeId === id) setRoom(d.room);
	} catch {
		setRoom(null);
	}
}

export async function roomAction(action, agentId) {
	if (state.busy) return toast("Espera a que termine la respuesta.", "info");
	try {
		await ensureSession();
		const d = await api(`/api/rooms/${encodeURIComponent(state.activeId)}`, { method: "POST", json: { action, agentId } });
		setRoom(d.room);
	} catch (err) {
		toast(err.message, "error");
	}
}

export function paintRoomBar() {
	const room = state.room;
	roomBar.hidden = !room && !state.agents.length;
	roomBar.innerHTML = "";
	if (roomBar.hidden) return;
	for (const p of room?.participants || []) {
		const chip = el("button", `room-chip${p.principal ? " principal" : ""}`);
		chip.type = "button";
		chip.title = p.principal ? `${p.name} responde si no nombras a otro` : `Nombra a ${p.name} para que responda`;
		chip.append(agentAvatar(p), document.createTextNode(p.name));
		if (p.principal) chip.append(el("span", "room-star", "★"));
		chip.onclick = () =>
			openMenu(chip, [
				...(p.principal ? [] : [{ label: "Hacer principal", icon: "sparkles", onClick: () => roomAction("promote", p.id) }]),
				{ label: "Quitar de la sala", icon: "x", danger: true, onClick: () => roomAction("remove", p.id) },
			]);
		roomBar.append(chip);
	}
	const others = state.agents.filter((a) => !room?.participants.some((p) => p.id === a.id));
	if (others.length) {
		const add = el("button", "room-chip add", `${icon("plus", "sm")}<span></span>`);
		add.type = "button";
		$("span", add).textContent = room ? "Sumar agente" : "Hablar con un agente";
		add.onclick = () => openMenu(add, others.map((a) => ({ label: a.name, onClick: () => roomAction("add", a.id) })));
		roomBar.append(add);
	}
}

/** Abre un chat nuevo que ya es una sala con este agente (Ajustes → Agentes, palabra de activación). */
export async function openRoom(agentId, { voiceMode } = {}) {
	try {
		const d = await api("/api/rooms", { method: "POST", json: { agentId } });
		if (settingsDlg.open) settingsDlg.close();
		upsertSession(d.session);
		await openChat(d.session.id);
		setRoom(d.room);
		if (voiceMode ?? d.agent.mode === "voice") voice.open({ greet: d.session.messages?.[0]?.content, agent: d.agent });
		return d;
	} catch (err) {
		toast(err.message, "error");
	}
}

export async function refreshAgents() {
	await loadAgents();
}

export async function persist(id = state.activeId, list = state.messages) {
	if (!id) return;
	const messages = list.filter((x) => !x.error && !x.streaming && (x.role === "user" || String(x.content).trim())).map(serialize);
	try {
		const d = await api(`/api/chat-sessions/${encodeURIComponent(id)}`, { method: "PUT", json: { messages } });
		upsertSession(d.session);
		if (state.activeId === id) setDocTitle(d.session.title);
		paintSidebar();
	} catch (err) {
		toast(`No se pudo guardar el chat: ${err.message}`, "error");
	}
}

export function regenerate(m) {
	if (state.busy) return;
	const idx = state.messages.indexOf(m);
	if (idx < 0) return;
	state.messages = state.messages.slice(0, idx);
	renderThread();
	runAssistant();
}

export function startEdit(m) {
	if (state.busy) return;
	const r = refs.get(m);
	const { text } = contentParts(m.content);
	const box = el("div", "edit-box", `<textarea aria-label="Editar mensaje"></textarea><div class="row"><button class="btn sm" data-x>Cancelar</button><button class="btn primary sm" data-ok>Enviar</button></div>`);
	const ta = $("textarea", box);
	ta.value = text;
	r.root.replaceChildren(box);
	ta.focus();
	ta.setSelectionRange(ta.value.length, ta.value.length);
	const fit = () => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight}px`;
	};
	fit();
	ta.oninput = fit;
	$("[data-x]", box).onclick = () => r.root.replaceWith(buildUser(m));
	const save = () => {
		const v = ta.value.trim();
		if (!v) return;
		const idx = state.messages.indexOf(m);
		state.messages = state.messages.slice(0, idx);
		state.messages.push({ role: "user", content: replaceText(m.content, v), ts: Date.now() });
		renderThread();
		runAssistant();
	};
	$("[data-ok]", box).onclick = save;
	ta.onkeydown = (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			save();
		} else if (e.key === "Escape") {
			e.stopPropagation();
			r.root.replaceWith(buildUser(m));
		}
	};
}
