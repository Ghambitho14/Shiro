// Bienvenida del primer arranque (quién eres, cómo se llama el asistente, dónde guardar y modelo)
// y el formulario "¿Dónde guardo tus cosas?" que también usa Ajustes → Datos.
import { api } from "./api.js";
import { hydrateIcons, icon } from "./icons.js";
import { mountModelForm } from "./modelForm.js";

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, className = "", html = "") {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (html) e.innerHTML = html;
	return e;
}

/** Aviso dentro de un formulario (ok, warn, bad o cargando). */
function notice(box, kind, text) {
	if (!box) return;
	if (!kind) {
		box.innerHTML = "";
		return;
	}
	const ico = { ok: "check", warn: "alert", bad: "alert", load: "loader" }[kind];
	box.innerHTML = `<div class="notice ${kind === "load" ? "" : kind}">${icon(ico, "sm")}<span></span></div>`;
	box.querySelector("span").textContent = text;
}

/** "Llevé 3 chats, 1 recuerdo y 5 notas." (solo lo que se llevó de verdad). */
function movedText(m) {
	if (!m) return "";
	const parts = [
		[m.chats, "chat", "chats"],
		[m.memories, "recuerdo", "recuerdos"],
		[m.reminders, "recordatorio", "recordatorios"],
		[m.files, "nota", "notas"],
	]
		.filter(([n]) => n > 0)
		.map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
	if (!parts.length) return "";
	return ` Llevé ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}` : parts[0]}.`;
}

let ctx = { toast: () => {}, onFinish: async () => {} };

/** onFinish: se llama al terminar la bienvenida (para recargar ajustes y chats). */
export function initSetup(options) {
	ctx = { ...ctx, ...options };
}

// ───────────────────────────── ¿Dónde guardo tus cosas? ─────────────────────────────

const KINDS = [
	{
		value: "local",
		title: "En este equipo",
		text: "Lo más sencillo: todo queda en la carpeta de Shiro de este ordenador.",
	},
	{
		value: "obsidian",
		title: "En Obsidian",
		text: "Tus chats, recuerdos y recordatorios se guardan como notas en la carpeta Shiro de tu bóveda: esa carpeta es la memoria de Shiro.",
	},
	{
		value: "supabase",
		title: "En Supabase",
		text: "Una base de datos en la nube: varios equipos con Shiro comparten los mismos chats y recuerdos.",
	},
];

/**
 * Monta el formulario en `container`. Devuelve { save } — save() guarda (probando antes la conexión)
 * y devuelve true si todo fue bien. Con `settings: true` muestra su propio botón Guardar (Ajustes → Datos).
 */
export async function mountStorageForm(container, { settings = false, onSaved } = {}) {
	container.innerHTML = `<div class="notice">${icon("loader", "sm")}<span>Cargando…</span></div>`;
	let info;
	try {
		info = await api("/api/storage");
	} catch (err) {
		notice(container, "bad", err.message);
		return { save: async () => false };
	}
	const name = `storage-${Math.random().toString(36).slice(2, 8)}`;
	container.innerHTML = `
		<div class="choice-list storage-kinds">${KINDS.map(
			(k) => `<label class="choice"><input type="radio" name="${name}" value="${k.value}" /><div><strong>${k.title}</strong><span>${k.text}</span></div></label>`,
		).join("")}</div>
		<div class="storage-detail" data-for="local">
			<p class="set-desc">Carpeta: <code class="mono"></code></p>
		</div>
		<div class="storage-detail" data-for="obsidian">
			<label class="field vault-pick" hidden><span>Tus bóvedas de Obsidian</span><select class="select"></select></label>
			<label class="field"><span>Carpeta de la bóveda</span><input class="input mono" data-f="vault" placeholder="C:\\Users\\tu-nombre\\Documents\\Mi bóveda" /><small>Shiro crea dentro una carpeta <b>Shiro</b> con tus chats, recuerdos, recordatorios y su memoria (SOUL.md, MEMORY.md…).</small></label>
		</div>
		<div class="storage-detail" data-for="supabase">
			<label class="field"><span>Dirección del proyecto</span><input class="input mono" data-f="url" placeholder="https://xxxx.supabase.co" /></label>
			<label class="field"><span>Clave secreta (service_role)</span><input class="input mono" data-f="key" type="password" autocomplete="off" /><small>Supabase → Project Settings → API Keys. Se guarda solo en este equipo: no se envía al navegador ni a nadie más.</small></label>
			<details class="sql-box">
				<summary>1.º Crea las tablas de Shiro (una vez por proyecto)</summary>
				<p class="set-desc">Copia esto, pégalo en Supabase → <b>SQL Editor</b> y pulsa <b>Run</b>.</p>
				<textarea class="textarea mono" readonly rows="8"></textarea>
				<div class="actions-row"><button type="button" class="btn sm" data-a="copy-sql">${icon("copy", "sm")}Copiar SQL</button></div>
			</details>
		</div>
		<label class="migrate-row" hidden><input type="checkbox" checked /> <span>Llevar mis chats, recuerdos, recordatorios y notas de memoria (MEMORY.md…) al nuevo sitio</span></label>
		<div class="actions-row">
			<button type="button" class="btn" data-a="test">Probar</button>
			${settings ? `<button type="button" class="btn primary" data-a="save">Guardar</button>` : ""}
		</div>
		<div class="storage-result"></div>`;

	const radios = [...container.querySelectorAll(`input[name="${name}"]`)];
	const vault = $('[data-f="vault"]', container);
	const url = $('[data-f="url"]', container);
	const key = $('[data-f="key"]', container);
	const result = $(".storage-result", container);
	const migrateRow = $(".migrate-row", container);
	const sqlBox = $(".sql-box", container);

	$('[data-for="local"] code', container).textContent = info.localFolder;
	vault.value = info.obsidianVault;
	url.value = info.supabaseUrl;
	key.placeholder = info.hasSupabaseKey ? "•••••• (guardada; escribe otra para cambiarla)" : "sb_secret_… o eyJ…";
	$("textarea", sqlBox).value = info.sql;

	if (info.vaults.length) {
		const pick = $(".vault-pick", container);
		const select = $("select", pick);
		select.innerHTML = `<option value="">Elige una…</option>` + info.vaults.map(() => "<option></option>").join("");
		info.vaults.forEach((v, i) => {
			const opt = select.options[i + 1];
			opt.value = v.path;
			opt.textContent = `${v.name} — ${v.path}`;
		});
		select.value = info.vaults.some((v) => v.path === info.obsidianVault) ? info.obsidianVault : "";
		select.onchange = () => select.value && (vault.value = select.value);
		pick.hidden = false;
	}

	const selected = () => radios.find((r) => r.checked)?.value || "local";
	const paint = () => {
		const kind = selected();
		for (const d of container.querySelectorAll(".storage-detail")) d.hidden = d.dataset.for !== kind;
		migrateRow.hidden = kind === info.kind && !(kind === "obsidian" && vault.value.trim() !== info.obsidianVault);
		notice(result, null);
	};
	(radios.find((r) => r.value === info.kind) || radios[0]).checked = true;
	for (const r of radios) r.onchange = paint;
	vault.oninput = paint;
	paint();

	const payload = () => ({ kind: selected(), obsidianVault: vault.value.trim(), supabaseUrl: url.value.trim(), supabaseKey: key.value.trim() });
	const showError = (message, missingTables) => {
		notice(result, "bad", message);
		if (missingTables) sqlBox.open = true;
	};

	$('[data-a="copy-sql"]', container).onclick = async () => {
		try {
			await navigator.clipboard.writeText(info.sql);
			ctx.toast("SQL copiado");
		} catch {
			$("textarea", sqlBox).select();
			ctx.toast("Selecciona el texto y cópialo con Ctrl+C", "error");
		}
	};

	$('[data-a="test"]', container).onclick = async () => {
		notice(result, "load", "Comprobando…");
		try {
			const r = await api("/api/storage/test", { method: "POST", json: payload() });
			if (!r.ok) return showError(r.error, r.missingTables);
			notice(result, r.warning ? "warn" : "ok", r.warning || "Todo bien: Shiro puede guardar ahí.");
		} catch (err) {
			notice(result, "bad", err.message);
		}
	};

	async function save() {
		const kind = selected();
		notice(result, "load", kind === info.kind ? "Guardando…" : "Comprobando y llevando tus datos… (puede tardar un poco)");
		try {
			const r = await api("/api/storage", { method: "PUT", json: { ...payload(), migrate: !migrateRow.hidden && $("input", migrateRow).checked } });
			const moved = movedText(r.migrated);
			info = { ...info, ...r };
			key.value = "";
			key.placeholder = info.hasSupabaseKey ? "•••••• (guardada; escribe otra para cambiarla)" : "sb_secret_… o eyJ…";
			paint();
			notice(result, r.warning ? "warn" : "ok", `Listo: tus cosas se guardan en ${r.label}.${moved}${r.warning ? ` ${r.warning}` : ""}`);
			await onSaved?.(r);
			return true;
		} catch (err) {
			// El servidor ya explica qué falta (tablas, clave pública, carpeta…).
			showError(err.message, /SQL Editor/.test(err.message));
			return false;
		}
	}

	const saveBtn = $('[data-a="save"]', container);
	if (saveBtn) saveBtn.onclick = save;
	return { save, label: () => KINDS.find((k) => k.value === selected())?.title.replace(/^En /, "") ?? "" };
}

// ───────────────────────────── bienvenida ─────────────────────────────

const STEPS = ["welcome", "you", "assistant", "storage", "model", "done"];

/** Abre la bienvenida. firstRun: la muestra la web al primer arranque (Esc no la cierra). */
export async function openSetup({ firstRun = false } = {}) {
	if (document.querySelector(".setup-dialog")) return;
	let settings, profile, llm;
	try {
		[settings, profile, llm] = await Promise.all([api("/api/settings"), api("/api/user-profile"), api("/api/llm-config")]);
	} catch (err) {
		ctx.toast(err.message, "error");
		return;
	}
	const d = el("dialog", "setup-dialog");
	d.innerHTML = `
		<div class="setup-head">
			<div class="setup-progress" aria-hidden="true">${STEPS.slice(1, -1).map(() => "<i></i>").join("")}</div>
			<button type="button" class="btn ghost sm" data-a="later">Ahora no</button>
		</div>
		<div class="setup-body">
			<section data-step="welcome" class="setup-welcome">
				<img src="/icons/icon-192.png" alt="" />
				<h2>¡Hola! Vamos a conocernos</h2>
				<p>Te haré unas preguntas rápidas para dejarlo todo listo. Puedes cambiar cualquier respuesta después en Ajustes.</p>
			</section>
			<section data-step="you">
				<h2>Sobre ti</h2>
				<p class="set-desc">Lo usaré en todas las conversaciones para responderte mejor.</p>
				<div class="grid-2">
					<label class="field"><span>¿Cómo quieres que te llame? *</span><input class="input" data-f="userName" maxlength="60" /></label>
					<label class="field"><span>Idioma de las respuestas</span><input class="input" data-f="language" placeholder="Español" maxlength="40" /></label>
				</div>
				<label class="field"><span>¿Qué debería saber de ti?</span><textarea class="textarea" data-f="about" maxlength="1500" placeholder="A qué te dedicas, tu edad, dónde vives, tus gustos…"></textarea></label>
				<label class="field"><span>¿Cómo quieres que te responda?</span><textarea class="textarea" data-f="extra" maxlength="1500" placeholder="Directo y breve, con humor, explícame como a principiante…"></textarea></label>
			</section>
			<section data-step="assistant">
				<h2>¿Cómo quieres llamarme?</h2>
				<p class="set-desc">Es el nombre con el que me presento y con el que me hablas (también en el modo voz).</p>
				<label class="field"><span>Nombre del asistente</span><input class="input" data-f="assistantName" maxlength="40" /></label>
			</section>
			<section data-step="storage">
				<h2>¿Dónde guardo tus cosas?</h2>
				<p class="set-desc">Tus chats, lo que recuerdo de ti y tus recordatorios. Los ajustes y las claves se quedan siempre en este equipo.</p>
				<div data-mount="storage"></div>
			</section>
			<section data-step="model">
				<h2>Mi cerebro (modelo de IA)</h2>
				<p class="set-desc">La IA que me hace pensar. Elige dónde funciona: en tu PC o en la nube. Si no lo sabes aún, puedes saltarlo.</p>
				<div data-mount="model"></div>
			</section>
			<section data-step="done" class="setup-welcome">
				<img src="/icons/icon-192.png" alt="" />
				<h2></h2>
				<ul class="setup-summary"></ul>
			</section>
		</div>
		<div class="setup-error"></div>
		<div class="setup-foot">
			<button type="button" class="btn" data-a="back">Atrás</button>
			<span class="spacer"></span>
			<button type="button" class="btn ghost" data-a="skip">Saltar</button>
			<button type="button" class="btn primary" data-a="next">Siguiente</button>
		</div>`;
	document.body.append(d);
	hydrateIcons(d);

	const f = (n) => $(`[data-f="${n}"]`, d);
	f("userName").value = profile.userName || "";
	f("language").value = profile.language || "Español";
	f("about").value = profile.about || "";
	f("extra").value = profile.extra || "";
	f("assistantName").value = settings.assistantName || "Shiro";

	const storageForm = await mountStorageForm($('[data-mount="storage"]', d));
	const modelForm = mountModelForm($('[data-mount="model"]', d), { llm, toast: ctx.toast });
	const errorBox = $(".setup-error", d);
	let step = 0;

	const close = () => {
		d.close();
		d.remove();
	};
	d.addEventListener("cancel", (e) => {
		if (firstRun) e.preventDefault();
		else close();
	});

	function show(i) {
		step = i;
		const id = STEPS[i];
		for (const s of d.querySelectorAll("[data-step]")) s.hidden = s.dataset.step !== id;
		[...d.querySelectorAll(".setup-progress i")].forEach((dot, n) => dot.classList.toggle("on", n < i));
		$('[data-a="back"]', d).hidden = i === 0 || id === "done";
		$('[data-a="skip"]', d).hidden = id !== "model";
		$('[data-a="later"]', d).hidden = id === "done";
		$('[data-a="next"]', d).textContent = id === "welcome" ? "Empezar" : id === "done" ? "Empezar a hablar" : "Siguiente";
		notice(errorBox, null);
		if (id === "done") {
			const who = f("userName").value.trim();
			const me = f("assistantName").value.trim() || "Shiro";
			$('[data-step="done"] h2', d).textContent = `¡Listo, ${who}! Soy ${me}.`;
			const items = [
				`Te llamaré <b></b>.`,
				`Guardo tus cosas en <b></b>.`,
				`Pienso con <b></b>.`,
			];
			const ul = $(".setup-summary", d);
			ul.innerHTML = items.map((t) => `<li>${icon("check", "sm")}<span>${t}</span></li>`).join("");
			const b = ul.querySelectorAll("b");
			b[0].textContent = who;
			b[1].textContent = storageForm.label?.() || "este equipo";
			b[2].textContent = modelForm.model() || "el modelo que elijas en Ajustes → Modelo";
		}
		const focus = d.querySelector(`[data-step="${id}"] input:not([type=radio]):not([type=checkbox]), [data-a="next"]`);
		setTimeout(() => focus?.focus(), 30);
	}

	const busy = async (fn) => {
		const btn = $('[data-a="next"]', d);
		btn.disabled = true;
		try {
			return await fn();
		} finally {
			btn.disabled = false;
		}
	};

	/** Guarda lo del paso actual; false si hay que quedarse (falta algo o falló). */
	async function commit(id) {
		try {
			if (id === "you") {
				if (!f("userName").value.trim()) {
					notice(errorBox, "bad", "Dime al menos cómo quieres que te llame.");
					f("userName").focus();
					return false;
				}
				await api("/api/user-profile", {
					method: "PUT",
					json: { userName: f("userName").value.trim(), language: f("language").value.trim(), about: f("about").value.trim(), extra: f("extra").value.trim() },
				});
			}
			if (id === "assistant") {
				await api("/api/settings", { method: "PUT", json: { assistantName: f("assistantName").value.trim() || "Shiro" } });
			}
			if (id === "storage") return await storageForm.save();
			if (id === "model") await modelForm.save();
			if (id === "done") {
				await api("/api/settings", { method: "PUT", json: { setupDone: true } });
				close();
				await ctx.onFinish();
			}
			return true;
		} catch (err) {
			notice(errorBox, "bad", err.message);
			return false;
		}
	}

	d.addEventListener("click", async (e) => {
		const a = e.target.closest("[data-a]")?.dataset.a;
		if (a === "back") show(Math.max(0, step - 1));
		if (a === "skip") show(step + 1);
		if (a === "later") {
			close();
			if (firstRun) ctx.toast("La bienvenida volverá a salir la próxima vez. También está en Ajustes → General.");
		}
		if (a === "next") await busy(async () => (await commit(STEPS[step])) && step < STEPS.length - 1 && show(step + 1));
	});
	d.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && e.target.matches("input.input") && !e.isComposing) {
			e.preventDefault();
			$('[data-a="next"]', d).click();
		}
	});

	d.showModal();
	show(0);
}
