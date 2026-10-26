// Panel del llama.cpp integrado (proveedor "llama.cpp integrado (archivos GGUF)"): descargar llama.cpp,
// los modelos GGUF del equipo, carpetas extra, contexto y memoria de la tarjeta gráfica.
// Lo usa el formulario de modelo (modelForm.js) en Ajustes → Modelo y en la bienvenida.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./markdown.js";

const $ = (sel, root) => root.querySelector(sel);

export function formatBytes(n) {
	if (!n) return "";
	const gb = n / 1024 ** 3;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`;
}

const IDLE_OPTIONS = [
	[0, "Nunca (siempre cargado)"],
	[5, "5 minutos"],
	[10, "10 minutos"],
	[30, "30 minutos"],
	[60, "1 hora"],
];
const BACKEND_OPTIONS = [
	["auto", "Automático"],
	["cuda", "CUDA (NVIDIA)"],
	["vulkan", "Vulkan (cualquier tarjeta)"],
	["cpu", "Solo procesador"],
];

function options(list, value) {
	const all = list.some(([v]) => String(v) === String(value)) ? list : [...list, [value, String(value)]];
	return all.map(([v, label]) => `<option value="${escapeHtml(String(v))}"${String(v) === String(value) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

/**
 * Monta el panel en `container`.
 * ctx: { toast, currentModel: () => string, onUseModel: async (id) => void, onLoaded?: (state) => void, promptDialog? }
 * Devuelve { refresh, alive }.
 */
export function mountLlamaCppPanel(container, ctx) {
	container.innerHTML = `
		<div class="llama-panel">
			<div class="llama-block" data-part="engine"></div>
			<div class="llama-block" data-part="server"></div>
			<div class="llama-block">
				<div class="llama-head"><strong>Modelos GGUF en este equipo</strong><button type="button" class="btn sm ghost" data-a="rescan">${icon("refresh", "sm")}<span>Buscar de nuevo</span></button></div>
				<div class="ext-list" data-part="models"></div>
				<div class="llama-folders" data-part="folders"></div>
			</div>
			<label class="field"><span>Liberar la tarjeta gráfica tras</span><select class="select" data-f="idle"></select><small>Si pasa ese tiempo sin mensajes, el modelo sale de la memoria (luego tarda unos segundos en volver). El contexto, la memoria comprimida y las capas en la tarjeta están en «Ajustes del modelo», más abajo.</small></label>
		</div>`;
	const part = (name) => $(`[data-part="${name}"]`, container);
	let st = null;
	let info = null;
	let timer = null;
	let wasInstalling = false;
	const alive = () => container.isConnected && Boolean($(".llama-panel", container));

	const toastError = (err) => ctx.toast?.(err.message || String(err), "error");

	async function refresh(fresh = false) {
		try {
			st = await api(`/api/llamacpp${fresh ? "?fresh=1" : ""}`);
		} catch (err) {
			part("engine").innerHTML = `<div class="notice bad">${icon("alert", "sm")}<span>${escapeHtml(err.message)}</span></div>`;
			return;
		}
		if (!alive()) return;
		// Antes de pintar: puede proponer un modelo, y la lista lo marca como "En uso".
		ctx.onLoaded?.(st);
		paint();
		const installing = ["downloading", "extracting"].includes(st.install.phase);
		if (wasInstalling && st.install.phase === "done") ctx.toast?.("llama.cpp está listo");
		wasInstalling = installing;
		schedule();
	}

	async function loadDownloadInfo(backend) {
		info = null;
		paintEngine();
		try {
			info = await api(`/api/llamacpp/download-info?backend=${encodeURIComponent(backend)}`);
		} catch (err) {
			info = { error: err.message };
		}
		if (alive()) paintEngine();
	}

	function schedule() {
		clearTimeout(timer);
		if (!alive() || !st) return;
		const installing = ["downloading", "extracting"].includes(st.install.phase);
		if (installing || st.server?.loading) timer = setTimeout(() => refresh(), installing ? 800 : 2000);
	}

	function paint() {
		paintEngine();
		paintServer();
		paintModels();
		paintFolders();
		$('[data-f="idle"]', container).innerHTML = options(IDLE_OPTIONS, st.idleMinutes);
	}

	function paintEngine() {
		const box = part("engine");
		if (!st) return;
		const ins = st.install;
		if (ins.phase === "downloading" || ins.phase === "extracting") {
			const pct = ins.total ? Math.min(100, Math.round((ins.received / ins.total) * 100)) : 0;
			box.innerHTML = `
				<div class="llama-head"><strong>${ins.phase === "extracting" ? "Descomprimiendo llama.cpp…" : "Descargando llama.cpp…"}</strong><span class="llama-muted">${escapeHtml(ins.tag || "")} ${escapeHtml(ins.variant || "")}</span></div>
				<div class="llama-progress"><i style="width:${ins.phase === "extracting" ? 100 : pct}%"></i></div>
				<div class="llama-muted">${ins.phase === "extracting" ? "Casi listo." : `${formatBytes(ins.received) || "0 MB"} de ${formatBytes(ins.total) || "…"} (${pct}%)`}</div>`;
			return;
		}
		const installed = st.installed;
		const upToDate = Boolean(installed && info && !info.error && info.tag === installed.tag && info.variant === installed.variant);
		const what = upToDate
			? `<div class="llama-muted">Tienes la última versión.</div>`
			: info
			? info.error
				? `<div class="notice warn">${icon("alert", "sm")}<span>${escapeHtml(info.error)}</span></div>`
				: `<div class="llama-muted">${info.gpu ? `Tu tarjeta: ${escapeHtml(info.gpu)}. ` : ""}Se descarga la versión ${escapeHtml(info.variant?.startsWith("cuda-") ? `CUDA ${info.variant.slice(5)}` : info.label)} (${escapeHtml(info.tag)}, ${formatBytes(info.sizeBytes)}).</div>`
			: `<div class="llama-muted">${icon("loader", "sm spin")} Consultando la última versión…</div>`;
		const error = ins.phase === "error" ? `<div class="notice bad">${icon("alert", "sm")}<span>${escapeHtml(ins.error || "La descarga falló.")}</span></div>` : "";
		const head = installed
			? `<div class="llama-head"><strong>llama.cpp ${escapeHtml(installed.tag)}</strong><span class="chip">${escapeHtml(installed.label)}${installed.variant.startsWith("cuda-") ? ` ${escapeHtml(installed.variant.slice(5))}` : ""}</span></div>`
			: `<div class="notice warn">${icon("download", "sm")}<span>Para usar archivos GGUF, Shiro descarga una vez llama.cpp (el programa oficial de ggml-org en GitHub). Después funciona sin internet.</span></div>`;
		box.innerHTML = `${head}${error}
			<div class="actions-row">
				<select class="select llama-backend" data-f="backend" aria-label="Versión de llama.cpp">${options(BACKEND_OPTIONS, st.backendChoice)}</select>
				<button type="button" class="btn ${installed ? "" : "primary"}" data-a="install" ${info && !info.error ? "" : "disabled"}>${icon(upToDate ? "refresh" : "download", "sm")}<span>${upToDate ? "Reinstalar" : installed ? "Actualizar" : "Descargar llama.cpp"}${info?.sizeBytes ? ` (${formatBytes(info.sizeBytes)})` : ""}</span></button>
			</div>${what}`;
	}

	function paintServer() {
		const box = part("server");
		if (!st.installed) {
			box.hidden = true;
			return;
		}
		box.hidden = false;
		const s = st.server;
		let text;
		if (!s) text = "llama.cpp está cerrado. Se abre solo con el primer mensaje (cargar el modelo tarda unos segundos).";
		else if (s.loading) text = `Cargando ${s.modelId} en la memoria…`;
		else if (s.sleeping) text = `En reposo: ${s.modelId} salió de la memoria y la tarjeta está libre. Vuelve a cargarse con el siguiente mensaje.`;
		else text = `En marcha: ${s.modelId} · contexto ${s.ctx.toLocaleString("es")} tokens${s.vision ? " · con visión" : ""}.`;
		box.innerHTML = `<div class="llama-head"><span class="llama-dot ${s ? (s.sleeping ? "sleep" : s.loading ? "load" : "on") : ""}"></span><span class="llama-server-text"></span>${
			s ? `<button type="button" class="btn sm" data-a="stop">${icon("power", "sm")}<span>Liberar la tarjeta ahora</span></button>` : ""
		}</div>`;
		$(".llama-server-text", box).textContent = text;
	}

	function paintModels() {
		const box = part("models");
		box.innerHTML = "";
		if (!st.models.length) {
			const empty = document.createElement("div");
			empty.className = "ext-empty";
			empty.textContent = `No encontré archivos GGUF. Descarga modelos con LM Studio u Ollama, copia archivos .gguf a ${st.modelsDir}, o añade la carpeta donde los tengas.`;
			box.append(empty);
			return;
		}
		const current = (ctx.currentModel?.() || "").toLowerCase();
		for (const m of st.models) {
			const row = document.createElement("div");
			row.className = "ext-item";
			row.title = m.path;
			row.innerHTML = `<div class="ext-item-text"><strong class="mono"></strong><span></span></div>${m.vision ? `<span class="chip tiny">Visión</span>` : ""}`;
			$("strong", row).textContent = m.id;
			$("span", row).textContent = `${m.sourceLabel} · ${formatBytes(m.sizeBytes)}`;
			if (m.id.toLowerCase() === current) {
				row.insertAdjacentHTML("beforeend", `<span class="chip accent">${icon("check", "sm")}En uso</span>`);
			} else {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "btn sm";
				b.textContent = "Usar";
				b.onclick = async () => {
					b.disabled = true;
					try {
						await ctx.onUseModel(m.id);
						paintModels();
					} catch (err) {
						toastError(err);
						b.disabled = false;
					}
				};
				row.append(b);
			}
			box.append(row);
		}
	}

	function paintFolders() {
		const box = part("folders");
		box.innerHTML = `<div class="llama-muted">Se buscan en LM Studio, en los modelos de Ollama y en <span class="mono"></span>. Carpetas extra:</div><div class="llama-chips"></div>`;
		$(".mono", box).textContent = st.modelsDir;
		const chips = $(".llama-chips", box);
		for (const f of st.folders) {
			const chip = document.createElement("span");
			chip.className = "chip path";
			chip.title = f;
			chip.textContent = f;
			const x = document.createElement("button");
			x.type = "button";
			x.className = "llama-chip-x";
			x.setAttribute("aria-label", `Quitar ${f}`);
			x.innerHTML = icon("x", "sm");
			x.onclick = () => saveFolders(st.folders.filter((p) => p !== f));
			const wrap = document.createElement("span");
			wrap.className = "llama-chip";
			wrap.append(chip, x);
			chips.append(wrap);
		}
		const add = document.createElement("button");
		add.type = "button";
		add.className = "btn sm";
		add.innerHTML = `${icon("folder", "sm")}<span>Añadir carpeta…</span>`;
		add.onclick = addFolder;
		chips.append(add);
	}

	async function saveFolders(folders) {
		try {
			st = await api("/api/llamacpp", { method: "PUT", json: { folders } });
			paint();
		} catch (err) {
			toastError(err);
		}
	}

	async function addFolder() {
		let path = "";
		if (st.canPickFolder) {
			try {
				const r = await api("/api/llamacpp/pick-folder", { method: "POST" });
				path = r.path || "";
				if (r.cancelled) return;
			} catch (err) {
				return toastError(err);
			}
		} else {
			const ask = ctx.promptDialog
				? await ctx.promptDialog({ title: "Añadir carpeta con modelos", text: "Ruta completa de la carpeta donde tienes archivos .gguf.", placeholder: "D:\\Modelos", ok: "Añadir" })
				: window.prompt("Ruta completa de la carpeta con modelos GGUF:");
			path = (ask || "").trim();
		}
		if (path) await saveFolders([...st.folders, path]);
	}

	async function putSetting(json) {
		try {
			st = await api("/api/llamacpp", { method: "PUT", json });
			paint();
		} catch (err) {
			toastError(err);
			refresh();
		}
	}

	container.addEventListener("click", async (e) => {
		const b = e.target.closest("[data-a]");
		if (!b || !container.contains(b)) return;
		if (b.dataset.a === "rescan") return refresh(true);
		if (b.dataset.a === "install") {
			b.disabled = true;
			try {
				await api("/api/llamacpp/install", { method: "POST", json: { backend: $('[data-f="backend"]', container).value } });
			} catch (err) {
				toastError(err);
			}
			return refresh();
		}
		if (b.dataset.a === "stop") {
			b.disabled = true;
			try {
				await api("/api/llamacpp/stop", { method: "POST" });
				ctx.toast?.("Tarjeta gráfica liberada");
			} catch (err) {
				toastError(err);
			}
			return refresh();
		}
	});

	container.addEventListener("change", (e) => {
		const f = e.target.dataset?.f;
		if (f === "idle") putSetting({ idleMinutes: Number(e.target.value) });
		else if (f === "backend") {
			putSetting({ backend: e.target.value });
			loadDownloadInfo(e.target.value);
		}
	});

	refresh().then(() => st && loadDownloadInfo(st.backendChoice));
	return { refresh, alive };
}
