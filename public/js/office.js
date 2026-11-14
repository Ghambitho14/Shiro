// Oficina: el departamento de Aku. Es una página propia (#/oficina, barra lateral), no un panel de cada chat:
// arriba el equipo (los agentes guardados: crear, editar, hablar con ellos) y abajo los escritorios de los ayudantes
// que trabajan con la tool delegate, de cualquier chat.
import { api } from "./api.js";
import { hydrateIcons, icon } from "./icons.js";
import { liveStream } from "./panels.js";
import { agentAvatar, editAgent, loadAgents, modelLabel, onAgentsChange, openAgentRoom } from "./agents.js";

const $ = (sel, root = document) => root.querySelector(sel);

function text(tag, className, value) {
	const e = document.createElement(tag);
	if (className) e.className = className;
	e.textContent = value;
	return e;
}

/** Sección «Equipo»: una tarjeta por agente; tocarla la edita, «Hablar» abre una sala con él. */
function paintTeam(agents, error) {
	const grid = $("#office-team");
	const note = $("#office-team-error");
	note.hidden = !error;
	note.textContent = error || "";
	grid.textContent = "";
	if (!agents.length) {
		grid.append(text("div", "team-empty", "Todavía no hay agentes en el equipo. Crea uno, por ejemplo Viernes, para las tareas del día."));
		return;
	}
	for (const a of agents) {
		const card = document.createElement("div");
		card.className = "team-card";
		card.tabIndex = 0;
		card.setAttribute("role", "listitem");
		card.title = `Editar a ${a.name}`;
		const head = document.createElement("div");
		head.className = "team-head";
		const who = document.createElement("div");
		who.className = "team-who";
		who.append(text("strong", "", a.name), text("span", "team-model", modelLabel(a)));
		const talk = document.createElement("button");
		talk.type = "button";
		talk.className = "btn sm";
		talk.title = `Abrir una sala con ${a.name}`;
		talk.innerHTML = `${icon(a.mode === "voice" ? "voice" : "users", "sm")}<span>Hablar</span>`;
		talk.onclick = (e) => {
			e.stopPropagation();
			openAgentRoom(a.id);
		};
		head.append(agentAvatar(a, "agent-dot team-avatar"), who, talk);
		card.append(head);
		card.append(text("p", "team-desc", a.description || "Sin descripción: tócalo para decir para qué sirve."));
		card.onclick = () => editAgent(a);
		card.onkeydown = (e) => e.key === "Enter" && e.target === card && editAgent(a);
		grid.append(card);
	}
}

const STATUS_TEXT = { working: "Trabajando", done: "Terminó", error: "Falló", stopped: "Detenido" };

/** "45 s", "3 min 10 s". */
function elapsed(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
}

export function initOffice({ toast }) {
	const list = $("#office-desks");
	const empty = $("#office-empty");
	const count = $("#office-count");
	const navCount = $("#office-nav-count");
	const stopAll = $("#office-stop");
	const desks = new Map();

	const post = (path, json) => api(path, { method: "POST", json }).catch((err) => toast(err.message, "error", 6000));

	function paintDesk(d) {
		let card = list.querySelector(`[data-id="${d.id}"]`);
		if (!card) {
			card = document.createElement("article");
			card.className = "desk";
			card.dataset.id = d.id;
			card.setAttribute("role", "listitem");
			card.innerHTML =
				'<div class="desk-head"><span class="desk-avatar"></span><div class="desk-who"><span class="desk-name"></span><span class="desk-boss"></span></div><span class="desk-status"></span><button class="icon-btn sm desk-stop" title="Detener a este ayudante" data-icon="stop" data-size="sm"></button></div><p class="desk-task"></p><div class="desk-step"><span class="pane-dot"></span><span class="desk-step-text"></span><span class="desk-time"></span></div><details class="desk-result"><summary>Resultado</summary><div class="desk-result-text"></div></details>';
			hydrateIcons(card);
			$(".desk-stop", card).onclick = () => post("/api/office/stop", { id: d.id });
			list.prepend(card);
		}
		card.dataset.status = d.status;
		const avatar = $(".desk-avatar", card);
		avatar.textContent = (d.name.trim()[0] || "?").toUpperCase();
		avatar.style.background = d.color || "";
		$(".desk-name", card).textContent = d.name;
		$(".desk-boss", card).textContent = `ayudante de ${d.boss}`;
		$(".desk-status", card).textContent = STATUS_TEXT[d.status] || d.status;
		$(".desk-stop", card).hidden = d.status !== "working";
		$(".desk-task", card).textContent = d.task;
		$(".desk-task", card).title = d.task;
		$(".desk-step-text", card).textContent = d.status === "working" ? d.step : `${d.step}${d.steps ? ` · ${d.steps} ${d.steps === 1 ? "paso" : "pasos"}` : ""}`;
		const result = $(".desk-result", card);
		result.hidden = !d.result;
		// El texto del modelo se muestra tal cual (sin HTML).
		$(".desk-result-text", card).textContent = d.result || "";
		$(".desk-result summary", card).textContent = d.status === "error" ? "Error" : "Resultado";
	}

	function paintTimes() {
		const now = Date.now();
		for (const d of desks.values()) {
			const t = list.querySelector(`[data-id="${d.id}"] .desk-time`);
			if (t) t.textContent = elapsed((d.endedAt || now) - d.startedAt);
		}
	}

	function paintSummary() {
		const all = [...desks.values()];
		const working = all.filter((d) => d.status === "working").length;
		empty.hidden = all.length > 0;
		list.hidden = all.length === 0;
		stopAll.disabled = working === 0;
		count.textContent = all.length ? (working ? `${working} trabajando` : `${all.length} ${all.length === 1 ? "escritorio" : "escritorios"}`) : "";
		// En la barra lateral: cuántos ayudantes trabajan ahora.
		navCount.hidden = working === 0;
		navCount.textContent = String(working);
		navCount.title = working ? `${working} ${working === 1 ? "ayudante trabajando" : "ayudantes trabajando"}` : "";
	}

	const stream = liveStream("/api/office/stream", (e) => {
		if (e.type === "snapshot") {
			list.textContent = "";
			desks.clear();
			for (const d of e.desks) {
				desks.set(d.id, d);
				paintDesk(d);
			}
		} else if (e.type === "desk") {
			desks.set(e.desk.id, e.desk);
			paintDesk(e.desk);
		} else if (e.type === "remove") {
			desks.delete(e.id);
			list.querySelector(`[data-id="${e.id}"]`)?.remove();
		}
		paintSummary();
		paintTimes();
	});

	// El flujo en vivo solo está abierto con la página a la vista o mientras Aku reparte tareas en este chat
	// (así el contador de la barra lateral se entera sin ocupar una conexión todo el rato).
	let pageOpen = false;
	let delegating = 0;
	let clock = 0;
	let idle = 0;
	const sync = () => {
		clearTimeout(idle);
		if (pageOpen || delegating > 0) return stream.start();
		// Un momento más para recibir el último estado de los escritorios.
		idle = setTimeout(() => stream.stop(), 3000);
	};

	onAgentsChange(paintTeam);
	$("#office-new-agent").onclick = () => editAgent(null);
	stopAll.onclick = () => post("/api/office/stop", {});
	$("#office-clear").onclick = () => post("/api/office/clear", {});
	paintSummary();

	return {
		/** La página de la Oficina se abre o se cierra. */
		setActive(on) {
			if (pageOpen === on) return;
			pageOpen = on;
			clearInterval(clock);
			if (on) {
				clock = setInterval(paintTimes, 1000);
				loadAgents();
			}
			sync();
		},
		/** Eventos de herramientas del chat: con `delegate` en marcha, la Oficina se mantiene al día. */
		onTool(evt) {
			if (evt.name !== "delegate") return;
			delegating = Math.max(0, delegating + (evt.phase === "start" ? 1 : -1));
			sync();
		},
	};
}
