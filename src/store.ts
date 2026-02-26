import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const STATE_FILE = join(DATA_DIR, "state.json");

const DEFAULT_NAME = "Shiro";

export type State = { name: string };

function loadState(): State {
	if (!existsSync(STATE_FILE)) {
		return { name: DEFAULT_NAME };
	}
	try {
		const raw = readFileSync(STATE_FILE, "utf-8");
		const data = JSON.parse(raw) as Partial<State>;
		return {
			name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : DEFAULT_NAME,
		};
	} catch {
		return { name: DEFAULT_NAME };
	}
}

let cached: State | null = null;

/** Estado persistente (nombre del asistente, etc.). El nombre lo puedes cambiar tú o el agente "que aprende". */
export function getState(): State {
	if (cached === null) cached = loadState();
	return cached;
}

/** Guarda el nombre (u otros campos). Lo puede invocar la CLI o el agente. */
export function setState(partial: Partial<State>): State {
	const current = getState();
	const next: State = { ...current, ...partial };
	if (!next.name.trim()) next.name = DEFAULT_NAME;
	else next.name = next.name.trim();
	cached = next;
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf-8");
	return next;
}

/** Resetea el estado (nombre) a valores por defecto y borra el archivo. */
export function resetState(): void {
	cached = { name: DEFAULT_NAME };
	if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}
