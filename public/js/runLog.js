// Ajustes → Registro: lo que hizo cada respuesta de Aku (herramientas, tiempos, tokens, errores)
// y el examen del agente (tareas fijas con el modelo de Ajustes). Datos de /api/runs y /api/agent-exam.
import { api } from "./api.js";
import { $, confirmDialog, el, toast } from "./ui.js";
import { formatCost } from "./messages.js";

let examTimer = null;

const OUTCOME = { ok: "Bien", error: "Error", cancelled: "Detenida", empty: "Sin respuesta" };
const MODE = { chat: "Chat", code: "Code", hacking: "Hacking" };

function seconds(ms) {
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function when(iso) {
	const d = new Date(iso);
	const today = new Date().toDateString() === d.toDateString();
	return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function runRow(e) {
	const card = el("div", "ext-card run-card");
	const row = el("div", "ext-row");
	row.tabIndex = 0;
	const bad = e.outcome === "error" || e.outcome === "empty";
	const failedTools = e.tools.filter((t) => !t.ok).length;
	const name = el("span", "ext-name path");
	name.textContent = e.goal || "(sin texto)";
	const time = el("span", "chip");
	time.textContent = when(e.at);
	const dur = el("span", "chip mono");
	dur.textContent = seconds(e.durationMs);
	const out = el("span", `chip run-outcome ${bad ? "bad" : e.outcome === "ok" ? "ok" : ""}`);
	out.textContent = OUTCOME[e.outcome] || e.outcome;
	row.append(name, el("span", "spacer"), time, dur);
	if (e.tools.length) {
		const t = el("span", `chip ${failedTools ? "run-outcome bad" : ""}`);
		t.textContent = failedTools ? `${e.tools.length} herr. · ${failedTools} fallaron` : `${e.tools.length} herr.`;
		row.append(t);
	}
	row.append(out);

	const body = el("div", "run-detail");
	body.hidden = true;
	const lines = [
		`<b>Modelo:</b> ${escape(e.provider || "?")} · ${escape(e.model || "?")}`,
		`<b>Modo:</b> ${MODE[e.mode] || escape(e.mode)} · permisos ${escape(e.permissions)}${e.subagent ? ` · ayudante (${escape(e.agent)})` : ""}`,
		`<b>Tokens:</b> ${e.usage.input.toLocaleString()} leídos · ${e.usage.output.toLocaleString()} escritos${e.usage.reasoning ? ` (${e.usage.reasoning.toLocaleString()} pensando)` : ""} · ${e.usage.turns} vueltas con el modelo`,
		`<b>Recuerdos traídos solos:</b> ${e.recalled}`,
	];
	if (typeof e.firstTextMs === "number") lines.splice(3, 0, `<b>Primera palabra:</b> a los ${seconds(e.firstTextMs)}`);
	if (typeof e.cost === "number") lines.splice(3, 0, `<b>Coste:</b> ${e.cost > 0 ? `≈ ${formatCost(e.cost)}` : "gratis"}${e.plan && e.cost > 0 ? " (incluido en tu suscripción: es lo que costaría pagando por uso)" : ""}`);
	if (e.fallbackFrom) lines.splice(1, 0, `<b>Respaldo:</b> respondió este porque ${escape(e.fallbackFrom)} no contestó`);
	if (e.error) lines.push(`<b>Error:</b> ${escape(e.error)}`);
	body.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
	if (e.tools.length) {
		const list = el("ol", "run-tools");
		for (const t of e.tools) {
			const li = el("li", t.ok ? "" : "bad");
			li.textContent = `${t.name} · ${seconds(t.ms)}${t.ok ? "" : ` · falló: ${t.error || "sin detalle"}`}`;
			list.append(li);
		}
		body.append(list);
	}
	const toggle = () => {
		body.hidden = !body.hidden;
		card.classList.toggle("open", !body.hidden);
	};
	row.addEventListener("click", toggle);
	row.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			toggle();
		}
	});
	card.append(row, body);
	return card;
}

function escape(s) {
	const d = document.createElement("div");
	d.textContent = String(s ?? "");
	return d.innerHTML;
}

/** Una tabla chica: cabeceras y filas de celdas (texto, o `[texto, clase]`). Todo va con textContent. */
function smallTable(title, heads, rows) {
	const wrap = el("div", "run-table");
	const h = el("h4");
	h.textContent = title;
	const scroll = el("div", "run-table-scroll");
	const table = el("table");
	const tr = el("tr");
	for (const name of heads) {
		const th = el("th");
		th.textContent = name;
		tr.append(th);
	}
	const thead = el("thead");
	thead.append(tr);
	const tbody = el("tbody");
	for (const cells of rows) {
		const row = el("tr");
		for (const c of cells) {
			const [text, cls] = Array.isArray(c) ? c : [c, ""];
			const td = el("td", cls);
			td.textContent = text;
			row.append(td);
		}
		tbody.append(row);
	}
	table.append(thead, tbody);
	scroll.append(table);
	wrap.append(h, scroll);
	return wrap;
}

/** Coste total de un modelo: «—» sin precio (los de tu PC), «gratis» o ≈ dólares («plan» si es de suscripción). */
const costCell = (m) => (typeof m.cost !== "number" ? "—" : m.cost > 0 ? `≈ ${formatCost(m.cost)}${m.plan ? " (plan)" : ""}` : "gratis");

const failCell = (failed, total) => (failed ? [`${failed} (${Math.round((failed / total) * 100)} %)`, "bad"] : ["0", ""]);

/** «Qué modelo y qué herramienta va mejor»: medias del resumen de /api/runs. */
function paintTables(summary) {
	const box = $("#runs-tables");
	box.replaceChildren();
	const models = summary.byModel || [];
	const tools = summary.byTool || [];
	box.hidden = !models.length && !tools.length;
	if (models.length) {
		box.append(
			smallTable(
				"Por modelo",
				["Modelo", "Respuestas", "Fallaron", "Tiempo medio", "1.ª palabra", "Tokens por respuesta", "Coste"],
				models.map((m) => [
					[`${m.model} · ${m.provider}`, "path"],
					String(m.runs),
					failCell(m.failed, m.runs),
					[seconds(m.avgMs), "mono"],
					[typeof m.avgFirstTextMs === "number" ? seconds(m.avgFirstTextMs) : "—", "mono"],
					[`${m.avgInput.toLocaleString()} leídos · ${m.avgOutput.toLocaleString()} escritos${m.avgReasoning ? ` (${m.avgReasoning.toLocaleString()} pensando)` : ""}`, "mono wrap"],
					[costCell(m), "mono"],
				]),
			),
		);
	}
	if (tools.length) {
		box.append(
			smallTable(
				"Por herramienta",
				["Herramienta", "Usos", "Fallaron", "Tiempo medio"],
				tools.map((t) => [[t.name, "mono"], String(t.uses), failCell(t.failed, t.uses), [seconds(t.avgMs), "mono"]]),
			),
		);
	}
}

async function loadRuns() {
	const box = $("#runs-list");
	const head = $("#runs-summary");
	try {
		const { entries, summary } = await api("/api/runs?limit=100");
		box.replaceChildren();
		paintTables(summary);
		if (!entries.length) {
			head.textContent = "Todavía no hay respuestas registradas.";
			head.className = "notice";
			return;
		}
		const tools = summary.failingTools.map((t) => `${t.name} (${t.failed} de ${t.total})`).join(", ");
		head.className = summary.failed ? "notice warn" : "notice ok";
		head.textContent =
			(summary.runs === 1
				? `La última respuesta ${summary.failed ? "terminó con error o vacía" : "salió bien"} y tardó ${seconds(summary.avgMs)}.`
				: `Últimas ${summary.runs} respuestas: ${summary.failed} con error o vacías, ${seconds(summary.avgMs)} de media.`) +
			(summary.totalCost > 0 ? ` Coste ≈ ${formatCost(summary.totalCost)}.` : "") +
			(tools ? ` Herramientas que más fallan: ${tools}.` : "");
		for (const e of entries) box.append(runRow(e));
	} catch (err) {
		head.className = "notice bad";
		head.textContent = err.message;
	}
}

function paintExam(status, tasks) {
	const btn = $("#exam-start");
	const info = $("#exam-status");
	const box = $("#exam-results");
	btn.disabled = status.running;
	btn.textContent = status.running ? "Examinando…" : "Hacer el examen";
	if (status.running) {
		info.className = "notice";
		info.textContent = `Tarea ${status.results.length + 1} de ${status.total}: ${status.current || "…"} (con ${status.model}). Puede tardar varios minutos.`;
	} else if (status.finishedAt && status.error) {
		info.className = "notice bad";
		info.textContent = `Último examen (${when(status.finishedAt)}, ${status.model}): ${status.error}`;
	} else if (status.finishedAt) {
		const pct = status.total ? Math.round((status.passed / status.total) * 100) : 0;
		info.className = pct >= 80 ? "notice ok" : pct >= 50 ? "notice warn" : "notice bad";
		info.textContent = `Último examen (${when(status.finishedAt)}, ${status.model}): ${status.passed} de ${status.total} aprobadas (${pct} %).${status.error ? " " + status.error : ""}`;
	} else {
		info.className = "notice";
		info.textContent = `${tasks.length} tareas fijas con el modelo de Ajustes → Modelo. Corren aparte: no tocan tu memoria, tus chats ni tus archivos.`;
	}
	box.replaceChildren();
	const done = new Map(status.results.map((r) => [r.id, r]));
	for (const t of tasks) {
		const r = done.get(t.id);
		const row = el("div", "exam-row");
		const mark = el("span", `exam-mark ${r ? (r.ok ? "ok" : "bad") : ""}`);
		mark.textContent = r ? (r.ok ? "✓" : "✗") : "·";
		const text = el("div", "exam-text");
		const title = el("strong");
		title.textContent = t.title;
		const desc = el("span");
		desc.textContent = r && !r.ok ? r.reason : t.measures;
		text.append(title, desc);
		row.append(mark, text);
		if (r) {
			const dur = el("span", "chip mono");
			dur.textContent = seconds(r.ms);
			row.append(dur);
			if (r.answer) row.title = `Respuesta: ${r.answer}`;
		}
		box.append(row);
	}
}

async function loadExam() {
	clearTimeout(examTimer);
	try {
		const { tasks, status } = await api("/api/agent-exam");
		paintExam(status, tasks);
		// Mientras corre, se pregunta cada 3 s si la pestaña sigue abierta.
		if (status.running && $("#settings-dialog").open && $('section[data-panel="runs"]').classList.contains("active")) {
			examTimer = setTimeout(loadExam, 3000);
		} else if (!status.running && status.finishedAt) {
			loadRuns();
		}
	} catch (err) {
		$("#exam-status").className = "notice bad";
		$("#exam-status").textContent = err.message;
	}
}

export function loadRunLog() {
	loadRuns();
	loadExam();
}

export function initRunLog() {
	$("#exam-start").addEventListener("click", async () => {
		try {
			await api("/api/agent-exam", { method: "POST", json: {} });
			loadExam();
		} catch (err) {
			toast(err.message, "error");
		}
	});
	$("#runs-refresh").addEventListener("click", loadRuns);
	$("#runs-clear").addEventListener("click", async () => {
		if (!(await confirmDialog({ title: "¿Borrar el registro?", text: "Se borra la lista de respuestas y sus herramientas. Los chats no se tocan.", ok: "Borrar", danger: true }))) return;
		await api("/api/runs", { method: "DELETE" }).catch((err) => toast(err.message, "error"));
		loadRuns();
	});
}
