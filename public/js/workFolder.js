// Botón de carpeta del modo Code (como en Claude): el chat trabaja en una carpeta de este equipo.
// Por debajo es un proyecto con esa carpeta vinculada (el que ya la tenga, o uno nuevo con su nombre),
// así Aku la lee, busca y cambia con la tool project y puede usar Claude Code ahí.

import * as projects from "./projects.js";
import { api } from "./api.js";
import { promptDialog } from "./extensions.js";
import { $, openMenu, prefs, savePrefs, toast } from "./ui.js";
import { state } from "./state.js";
import { inProjectHome } from "./messages.js";
import { newChat, paintSidebar } from "./sidebar.js";

const baseName = (path) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** La carpeta para el próximo chat nuevo de Code (se recuerda entre recargas). */
function pendingProject() {
	const p = prefs.workProject ? projects.findProject(prefs.workProject) : null;
	return p?.folders?.length ? p : null;
}

function setPending(id) {
	prefs.workProject = id || "";
	savePrefs();
}

/** El proyecto del chat abierto o, en un chat nuevo, el de la carpeta elegida. */
function currentProject() {
	return state.activeId ? projects.projectOfChat(state.activeId) : pendingProject();
}

/** Para `ensureSession` (chat.js): el proyecto en que nace un chat nuevo de Code. */
export function workProjectForNewChat() {
	return state.mode === "code" ? pendingProject()?.id ?? null : null;
}

export function paintWorkFolder() {
	const btn = $("#folder-btn");
	if (!btn) return;
	btn.hidden = state.mode !== "code" || (state.view || "chat") !== "chat" || inProjectHome();
	if (btn.hidden) return;
	const p = currentProject();
	const folder = p?.folders?.[0];
	$("#folder-label").textContent = folder ? baseName(folder) : p ? p.name : "Elegir carpeta";
	btn.title = folder ? `Aku trabaja en ${folder}` + (p.folders.length > 1 ? ` y ${p.folders.length - 1} carpeta(s) más del proyecto «${p.name}»` : "") : p ? `Proyecto «${p.name}»` : "Elige la carpeta en la que trabajará Aku";
	btn.classList.toggle("active", Boolean(p));
}

/** Pasa a trabajar en una carpeta: un chat ya empezado no cambia de carpeta, se abre uno nuevo. */
async function useFolder(path) {
	let project;
	try {
		project = (await api("/api/projects/for-folder", { method: "POST", json: { path } })).project;
	} catch (err) {
		toast(err.message, "error", 6000);
		return;
	}
	projects.upsertSummary(project);
	setPending(project.id);
	if (state.activeId && projects.projectOfChat(state.activeId)?.id !== project.id) newChat();
	paintSidebar();
	paintWorkFolder();
}

async function pickFolder(canPick) {
	let path = null;
	if (canPick) {
		toast("Elige la carpeta en la ventana que se ha abierto…", "info", 5000);
		try {
			const d = await api("/api/projects/pick-folder", { method: "POST", json: { purpose: "code" } });
			if (d.cancelled) return;
			path = d.path;
		} catch {
			// Si el selector de Windows falla, se escribe la ruta a mano.
		}
	}
	path ??= await promptDialog({
		title: "Elegir carpeta",
		text: "Aku trabajará en esta carpeta: leerá sus archivos y, para cambiarlos o correr comandos, te pedirá permiso.",
		placeholder: "C:\\Users\\tu-usuario\\GitHub\\mi-proyecto",
		ok: "Usar esta carpeta",
	});
	if (path) await useFolder(path);
}

async function openFolderMenu() {
	if (state.busy) {
		toast("Espera a que termine la respuesta para cambiar de carpeta.");
		return;
	}
	let folders = [];
	let canPick = projects.store.canPickFolder;
	try {
		const d = await api("/api/projects/recent-folders");
		folders = d.folders || [];
		canPick = Boolean(d.canPickFolder);
	} catch (err) {
		toast(err.message, "error");
	}
	const current = currentProject();
	const items = folders
		.filter((f) => f.exists)
		.map((f) => ({
			label: f.name,
			title: f.path,
			icon: current?.folders?.includes(f.path) ? "check" : "folder",
			onClick: () => useFolder(f.path),
		}));
	if (items.length) items.push("sep");
	items.push({ label: canPick ? "Elegir otra carpeta…" : "Escribir la ruta de una carpeta…", icon: "folderPlus", onClick: () => pickFolder(canPick) });
	// Sin carpeta: solo para chats nuevos (uno empezado se queda en la suya).
	if (!state.activeId && current) {
		items.push({
			label: "Sin carpeta",
			icon: "x",
			onClick: () => {
				setPending("");
				paintWorkFolder();
			},
		});
	}
	openMenu($("#folder-btn"), items);
}

export function initWorkFolder() {
	$("#folder-btn").onclick = openFolderMenu;
	paintWorkFolder();
}
