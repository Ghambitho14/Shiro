/**
 * Oficina de Shiro: los ayudantes (subagentes) que crea con la tool `delegate`, cada uno en su
 * escritorio con su tarea y lo que está haciendo. El panel "Oficina" de la web la ve en vivo
 * (`/api/office/stream`) y puede parar a cada uno. Solo en memoria: se vacía al reiniciar.
 */
import { randomBytes } from "node:crypto";

export type DeskStatus = "working" | "done" | "error" | "stopped";

export type Desk = {
	id: string;
	name: string;
	color?: string;
	/** Quién lo creó (Shiro o el agente de la sala que responde). */
	boss: string;
	task: string;
	status: DeskStatus;
	/** Lo que está haciendo ahora («Buscando en Internet…») o cómo terminó. */
	step: string;
	/** Herramientas usadas hasta ahora. */
	steps: number;
	startedAt: number;
	endedAt?: number;
	/** El principio de su resultado (o del error). */
	result?: string;
};

export type OfficeEvent = { type: "snapshot"; desks: Desk[] } | { type: "desk"; desk: Desk } | { type: "remove"; id: string };

const MAX_DESKS = 30;
const RESULT_PREVIEW_CHARS = 1500;

class Office {
	private desks: Desk[] = [];
	private listeners = new Set<(e: OfficeEvent) => void>();
	private stops = new Map<string, () => void>();

	subscribe(fn: (e: OfficeEvent) => void): () => void {
		this.listeners.add(fn);
		fn({ type: "snapshot", desks: this.list() });
		return () => this.listeners.delete(fn);
	}

	list(): Desk[] {
		return this.desks.map((d) => ({ ...d }));
	}

	private emit(e: OfficeEvent): void {
		for (const fn of this.listeners) {
			try {
				fn(e);
			} catch {
				/* un panel roto no afecta a los demás */
			}
		}
	}

	/** Un escritorio nuevo para un ayudante que empieza; `onStop` lo detiene (botón del panel). */
	open(input: { name: string; color?: string; boss: string; task: string }, onStop: () => void): Desk {
		const desk: Desk = {
			id: randomBytes(6).toString("hex"),
			name: input.name,
			color: input.color,
			boss: input.boss,
			task: input.task,
			status: "working",
			step: "Empezando…",
			steps: 0,
			startedAt: Date.now(),
		};
		this.desks.push(desk);
		this.stops.set(desk.id, onStop);
		// Los más viejos que ya terminaron dejan sitio.
		while (this.desks.length > MAX_DESKS) {
			const idx = this.desks.findIndex((d) => d.status !== "working");
			if (idx < 0) break;
			const [gone] = this.desks.splice(idx, 1);
			this.emit({ type: "remove", id: gone!.id });
		}
		this.emit({ type: "desk", desk: { ...desk } });
		return desk;
	}

	/** Lo que está haciendo ahora (cada herramienta que empieza). */
	step(id: string, label: string): void {
		const desk = this.desks.find((d) => d.id === id);
		if (!desk || desk.status !== "working") return;
		desk.step = label;
		desk.steps++;
		this.emit({ type: "desk", desk: { ...desk } });
	}

	finish(id: string, status: Exclude<DeskStatus, "working">, result: string): void {
		this.stops.delete(id);
		const desk = this.desks.find((d) => d.id === id);
		if (!desk || desk.status !== "working") return;
		desk.status = status;
		desk.endedAt = Date.now();
		desk.step = status === "done" ? "Terminó" : status === "stopped" ? "Detenido" : "Falló";
		desk.result = result.length > RESULT_PREVIEW_CHARS ? result.slice(0, RESULT_PREVIEW_CHARS - 1) + "…" : result;
		this.emit({ type: "desk", desk: { ...desk } });
	}

	/** Detiene a un ayudante (o a todos sin id). Devuelve cuántos se detuvieron. */
	stop(id?: string): number {
		const ids = id ? [id] : [...this.stops.keys()];
		let n = 0;
		for (const i of ids) {
			const fn = this.stops.get(i);
			if (!fn) continue;
			this.stops.delete(i);
			fn();
			n++;
		}
		return n;
	}

	/** Quita los escritorios de los que ya terminaron. */
	clear(): void {
		this.desks = this.desks.filter((d) => d.status === "working");
		this.emit({ type: "snapshot", desks: this.list() });
	}
}

export { Office };
export const office = new Office();
