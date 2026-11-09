// Medidor de contexto de la caja de escribir: cuánto del contexto del modelo ocupa el chat y en qué.
// Muestra lo que midió la última respuesta (se guarda con ella) o, si no hay, lo estima el servidor
// sin llamar al modelo (POST /api/chat/context). El total real lo cuenta el modelo; el reparto es aproximado.
import { $, closeMenu, el, openMenuEl, showMenu } from "./ui.js";
import { state } from "./state.js";
import { api } from "./api.js";

const PARTS = {
	messages: "Mensajes",
	instructions: "Instrucciones de Aku",
	tools: "Herramientas de Aku",
	mcp: "Herramientas MCP",
	memory: "Memoria y notas",
	skills: "Habilidades",
	project: "Proyecto",
	toolResults: "Resultados de herramientas",
};

/** Largo del círculo del anillo (r = 8 en un viewBox de 20). */
const RING = 2 * Math.PI * 8;

let current = null;
let timer = 0;
let seq = 0;

const num = (n) => Math.round(n).toLocaleString("es");
const short = (n) =>
	n >= 1e6
		? `${(n / 1e6).toLocaleString("es", { maximumFractionDigits: 1 })}M`
		: n >= 1000
			? `${(n / 1000).toLocaleString("es", { maximumFractionDigits: n >= 10_000 ? 0 : 1 })}k`
			: String(Math.round(n));
const percent = (part, whole) => {
	const p = (part / whole) * 100;
	return p > 0 && p < 1 ? "<1 %" : `${p.toLocaleString("es", { maximumFractionDigits: p < 10 ? 1 : 0 })} %`;
};

/** La medida de la última respuesta, si el chat termina en una (y ya acabó). */
function savedReport() {
	const last = state.messages?.[state.messages.length - 1];
	return last?.role === "assistant" && !last.streaming && last.context?.used ? last.context : null;
}

/** El chat tal como se enviaría, sin el peso de las imágenes (el servidor las cuenta igual). */
function payload() {
	return (state.messages || [])
		.filter((m) => !m.error && !m.streaming)
		.map((m) => ({
			role: m.role,
			content: Array.isArray(m.content)
				? m.content.map((p) => (p.type === "image_url" ? { type: "image_url", image_url: { url: "data:," } } : p))
				: m.content,
			...(m.agent ? { agent: m.agent, agentName: m.agentName } : {}),
		}));
}

async function estimate() {
	const mine = ++seq;
	try {
		const r = await api("/api/chat/context", {
			method: "POST",
			json: { messages: payload(), sessionId: state.activeId || undefined, mode: state.mode, permissions: state.permissions },
		});
		if (mine !== seq) return;
		if (r?.context) paint(r.context);
	} catch {
		// Sin conexión o sin modelo: el medidor se queda como estaba.
	}
}

/** Vuelve a mirar el medidor (al abrir un chat, terminar una respuesta o cambiar modo, permisos o modelo). */
export function refreshContextMeter() {
	clearTimeout(timer);
	const saved = savedReport();
	if (saved) {
		seq++;
		paint(saved);
		return;
	}
	timer = setTimeout(estimate, 350);
}

function paint(report) {
	current = report;
	const btn = $("#ctx-btn");
	if (!btn) return;
	btn.hidden = false;
	const ratio = report.limit ? report.used / report.limit : null;
	$("#ctx-ring").style.strokeDasharray = `${RING * Math.min(ratio ?? 0, 1)} ${RING}`;
	btn.classList.toggle("warn", ratio !== null && ratio >= 0.7 && ratio < 0.9);
	btn.classList.toggle("full", ratio !== null && ratio >= 0.9);
	$("#ctx-label").textContent = ratio !== null ? percent(report.used, report.limit) : short(report.used);
	const what = ratio !== null ? `${num(report.used)} de ${num(report.limit)} tokens (${percent(report.used, report.limit)})` : `${num(report.used)} tokens`;
	btn.title = `Contexto: ${what}. Pulsa para ver en qué se usa.`;
	btn.setAttribute("aria-label", `Contexto usado: ${what}`);
	if (openMenuEl?.classList.contains("ctx-menu")) openPanel();
}

function openPanel() {
	const r = current;
	if (!r) return;
	const whole = r.limit || r.used;
	const menu = el("div", "menu ctx-menu");
	menu.setAttribute("role", "dialog");
	menu.setAttribute("aria-label", "Contexto del modelo");

	const head = el("div", "ctx-head");
	head.append(el("strong", "", "Contexto"), Object.assign(el("span", "ctx-tag"), { textContent: r.preview ? "Estimado antes de enviar" : "Última respuesta" }));

	const sum = el("div", "ctx-sum");
	const used = el("span", "ctx-used");
	used.textContent = r.limit ? `${percent(r.used, r.limit)} usado` : `${short(r.used)} tokens`;
	const of = el("span", "ctx-of");
	of.textContent = r.limit ? `${short(r.used)} / ${short(r.limit)}` : "tamaño desconocido";
	sum.append(used, of);

	const bar = el("div", "ctx-bar");
	const list = el("div", "ctx-list");
	for (const p of r.parts) {
		const seg = el("span", `ctx-seg ctx-${p.id}`);
		seg.style.width = `${Math.min(100, (p.tokens / whole) * 100)}%`;
		bar.append(seg);
		list.append(row(p.id, PARTS[p.id] || p.id, p.tokens, whole));
	}
	if (r.limit && r.limit > r.used) list.append(row("free", "Libre", r.limit - r.used, r.limit));

	const notes = [];
	if (r.limit && r.used > r.limit) notes.push("No cabe todo: el modelo pudo perder parte de lo que se le envió.");
	if (r.total > r.sent) notes.push(`Se enviaron ${num(r.sent)} de ${num(r.total)} mensajes: los más antiguos no cupieron.`);
	if (r.preview) notes.push("El total real se ve al responder.");
	else notes.push(r.exact ? "El total lo contó el modelo; el reparto entre partes es aproximado." : "Estimado: el modelo no dijo cuántos tokens leyó.");
	if (!r.limit) notes.push("Este proveedor no dice cuánto contexto tiene el modelo (en LM Studio se sabe cuando está cargado).");
	if (r.parts.some((p) => p.id === "toolResults")) notes.push("Lo que trajeron las herramientas solo cuenta en esa respuesta: no se reenvía en el siguiente mensaje.");
	const foot = el("div", "ctx-notes");
	for (const n of notes) foot.append(Object.assign(el("p"), { textContent: n }));

	menu.append(head, sum, bar, list, foot);
	showMenu(menu, $("#ctx-btn"));
}

function row(id, label, tokens, whole) {
	const line = el("div", "ctx-row");
	const name = el("span", "ctx-name");
	name.append(el("i", `ctx-dot ctx-${id}`), Object.assign(el("span"), { textContent: label }));
	line.append(name, Object.assign(el("span", "ctx-num"), { textContent: short(tokens) }), Object.assign(el("span", "ctx-pct"), { textContent: percent(tokens, whole) }));
	return line;
}

export function initContextMeter() {
	// El botón abre y cierra la ventanita (pulsar fuera también la cierra).
	$("#ctx-btn").onclick = () => (openMenuEl?.classList.contains("ctx-menu") ? closeMenu() : openPanel());
}
