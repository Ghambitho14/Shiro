// Menú de comandos: aparece al escribir "/" al principio del cuadro de texto.
// Lista los comandos (/ayuda, /modelo…) y las habilidades activas (/nombre).

import { api } from "./api.js";
import { icon } from "./icons.js";

/** Comandos que no necesitan nada más: con Enter se envían directamente. */
const NO_ARGS = new Set(["ayuda", "nuevo", "estado", "habilidades", "mcp"]);

export class CommandPalette {
	constructor(input, anchor, { onSubmit }) {
		this.input = input;
		this.onSubmit = onSubmit;
		this.items = [];
		this.index = 0;
		this.data = null;
		this.fetchedAt = 0;
		this.box = document.createElement("div");
		this.box.className = "cmd-palette";
		this.box.hidden = true;
		this.box.setAttribute("role", "listbox");
		this.box.setAttribute("aria-label", "Comandos");
		anchor.append(this.box);
		input.addEventListener("input", () => this.update());
		// En captura: tiene que ir antes que el Enter que envía el mensaje.
		input.addEventListener("keydown", (e) => this.onKey(e), true);
		input.addEventListener("blur", () => setTimeout(() => this.close(), 150));
	}

	get open() {
		return !this.box.hidden;
	}

	async load() {
		if (this.data && Date.now() - this.fetchedAt < 30_000) return this.data;
		try {
			this.data = await api("/api/commands");
			this.fetchedAt = Date.now();
		} catch {
			this.data ??= { commands: [], skills: [] };
		}
		return this.data;
	}

	async update() {
		const value = this.input.value;
		const m = /^\/(\S*)$/.exec(value);
		if (!m) return this.close();
		const data = await this.load();
		if (this.input.value !== value) return; // siguió escribiendo mientras cargaba
		const q = m[1].toLowerCase();
		// Primero lo que empieza igual que lo escrito; los alias en inglés ("reset") y las coincidencias
		// a mitad de nombre van detrás.
		const cmds = data.commands
			.map((c) => ({
				kind: "cmd",
				name: c.name,
				usage: c.usage,
				description: c.description,
				score: c.name.startsWith(q) ? 3 : c.aliases.some((a) => a.startsWith(q)) ? 1 : 0,
			}))
			.filter((c) => c.score > 0);
		const skills = data.skills
			.map((s) => {
				const n = s.name.toLowerCase();
				return { kind: "skill", name: s.name, description: s.description, score: n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0 };
			})
			.filter((s) => s.score > 0);
		this.items = [...cmds, ...skills].sort((a, b) => b.score - a.score).slice(0, 14);
		if (!this.items.length) return this.close();
		this.index = 0;
		this.render();
	}

	render() {
		this.box.innerHTML = "";
		let lastKind = "";
		this.items.forEach((it, i) => {
			if (it.kind !== lastKind) {
				const h = document.createElement("div");
				h.className = "cmd-group";
				h.textContent = it.kind === "cmd" ? "Comandos" : "Habilidades";
				this.box.append(h);
				lastKind = it.kind;
			}
			const b = document.createElement("button");
			b.type = "button";
			b.className = `cmd-item${i === this.index ? " active" : ""}`;
			b.setAttribute("role", "option");
			b.setAttribute("aria-selected", String(i === this.index));
			b.innerHTML = `${icon(it.kind === "cmd" ? "terminal" : "puzzle", "sm")}<strong></strong><span class="cmd-desc"></span>`;
			b.querySelector("strong").textContent = it.usage && it.kind === "cmd" ? it.usage : `/${it.name}`;
			b.querySelector(".cmd-desc").textContent = it.description;
			b.addEventListener("mousedown", (e) => e.preventDefault()); // no quitar el foco al cuadro de texto
			b.addEventListener("click", () => this.choose(i, true));
			this.box.append(b);
		});
		this.box.hidden = false;
		this.box.querySelector(".cmd-item.active")?.scrollIntoView({ block: "nearest" });
	}

	onKey(e) {
		if (!this.open || e.isComposing) return;
		const stop = () => {
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			stop();
			const n = this.items.length;
			this.index = (this.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
			this.render();
		} else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
			stop();
			this.choose(this.index, e.key === "Enter");
		} else if (e.key === "Escape") {
			stop();
			this.close();
		}
	}

	choose(i, submit) {
		const it = this.items[i];
		if (!it) return;
		this.close();
		if (submit && it.kind === "cmd" && NO_ARGS.has(it.name)) {
			this.input.value = `/${it.name}`;
			this.onSubmit();
			return;
		}
		this.input.value = `/${it.name} `;
		this.input.focus();
		this.input.dispatchEvent(new Event("input"));
	}

	close() {
		this.box.hidden = true;
		this.items = [];
	}
}
