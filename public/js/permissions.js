// Los botones de la caja de escribir: cómo trabaja el agente (permisos, también planear) y si razona más.
// Valen en cualquier modo (Chat, Code, Hacking) y van en cada petición; el servidor los valida.
import { icon, setIcon } from "./icons.js";
import { $, el, prefs, savePrefs, showMenu, closeMenu } from "./ui.js";
import { state } from "./state.js";

const OPTIONS = {
	ask: { icon: "shield", label: "Preguntar", desc: "Pide permiso antes de cada acción delicada." },
	plan: { icon: "file", label: "Planear", desc: "Solo lee e investiga, y te propone los pasos. No cambia nada." },
	auto: { icon: "zap", label: "Automático", desc: "Hace comandos y archivos sin preguntar. Lo peligroso sí lo pregunta." },
	bypass: { icon: "alert", label: "Omitir permisos", desc: "No pregunta nada. Se quita al recargar la página.", danger: true },
};

const NOTES = {
	plan: "Planear: investiga y propone pasos con solo lectura; no cambia archivos ni ejecuta comandos.",
	auto: "Automático: hace comandos y archivos sin preguntar; borrar, apagar o usar webs sigue pidiendo permiso.",
	bypass: "Omitir permisos: no te preguntará nada. Se quita al recargar la página.",
};

let onChange = () => {};

/** «Bloquear» en Ajustes → Permisos manda: nada de hacer cosas sin preguntar. */
const blocked = (value) => state.settings?.approvalMode === "deny" && (value === "auto" || value === "bypass");

/** Aviso bajo la caja de escribir, si lo elegido cambia lo normal. */
export const permissionNote = () => NOTES[state.permissions] || "";

export function setPermissions(value) {
	state.permissions = value in OPTIONS && !blocked(value) ? value : "ask";
	// Omitir permisos no se recuerda: abrir Shiro otro día no debe empezar sin preguntar nada.
	prefs.permissions = state.permissions === "bypass" ? "ask" : state.permissions;
	savePrefs();
	paintPermissions();
	onChange();
}

export function paintPermissions() {
	if (blocked(state.permissions)) state.permissions = "ask";
	// «No preguntar nunca» en Ajustes hace lo mismo que Omitir permisos: se muestra tal cual es.
	const fromSettings = state.settings?.approvalMode === "allow" && state.permissions !== "plan";
	const option = OPTIONS[fromSettings ? "bypass" : state.permissions];
	const btn = $("#perm-btn");
	setIcon($("#perm-icon"), option.icon);
	$("#perm-label").textContent = option.label;
	btn.title = fromSettings ? "Ajustes → Permisos está en «No preguntar nunca»." : option.desc;
	btn.classList.toggle("active", fromSettings || state.permissions !== "ask");
	btn.classList.toggle("danger", Boolean(option.danger));

	const reason = $("#reason-btn");
	const fixed = state.llm?.fixedThinking === true;
	const on = state.moreReasoning && !fixed;
	reason.classList.toggle("active", on);
	reason.classList.toggle("muted", fixed);
	reason.setAttribute("aria-pressed", String(on));
	reason.title = fixed
		? "Con este modelo Aku no puede elegir cuánto piensa: se queda como venga."
		: on
			? "Encendido: el modelo piensa al máximo antes de responder (tarda más y gasta más)."
			: "Pide al modelo que piense al máximo antes de responder. Apagado usa lo de Ajustes → Modelo.";
}

function openPermissionMenu() {
	const anchor = $("#perm-btn");
	const menu = el("div", "menu perm-menu");
	menu.setAttribute("role", "menu");
	for (const [value, option] of Object.entries(OPTIONS)) {
		const selected = state.permissions === value;
		const item = el(
			"button",
			`menu-item perm-item${option.danger ? " danger" : ""}`,
			`${icon(option.icon, "sm")}<span class="perm-text"><strong></strong><small></small></span>${selected ? icon("check", "sm") : ""}`,
		);
		item.type = "button";
		item.setAttribute("role", "menuitemradio");
		item.setAttribute("aria-checked", String(selected));
		$("strong", item).textContent = option.label;
		$("small", item).textContent = blocked(value) ? "Ajustes → Permisos está en «Bloquear»." : option.desc;
		item.disabled = blocked(value);
		item.onclick = () => {
			closeMenu();
			setPermissions(value);
		};
		menu.append(item);
	}
	showMenu(menu, anchor);
	menu.querySelector("button:not(:disabled)")?.focus();
}

export function initPermissions({ onChange: changed } = {}) {
	if (changed) onChange = changed;
	// Este icono lo pone paintPermissions: hydrateIcons no debe añadir otro.
	$("#perm-icon").dataset.iconDone = "1";
	state.permissions = prefs.permissions in OPTIONS && prefs.permissions !== "bypass" ? prefs.permissions : "ask";
	state.moreReasoning = prefs.moreReasoning === true;
	$("#perm-btn").onclick = openPermissionMenu;
	$("#reason-btn").onclick = () => {
		state.moreReasoning = !state.moreReasoning;
		prefs.moreReasoning = state.moreReasoning;
		savePrefs();
		paintPermissions();
	};
	paintPermissions();
}
