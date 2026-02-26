import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const HEALTH_FILE = join(DATA_DIR, "health.json");

export type HealthState = {
	lastActive: string;
	status: "idle" | "active";
};

function loadHealth(): HealthState {
	if (!existsSync(HEALTH_FILE)) {
		return { lastActive: new Date().toISOString(), status: "idle" };
	}
	try {
		const raw = readFileSync(HEALTH_FILE, "utf-8");
		const data = JSON.parse(raw) as Partial<HealthState>;
		return {
			lastActive: typeof data.lastActive === "string" ? data.lastActive : new Date().toISOString(),
			status: data.status === "active" ? "active" : "idle",
		};
	} catch {
		return { lastActive: new Date().toISOString(), status: "idle" };
	}
}

let cached: HealthState | null = null;

export function getHealth(): HealthState {
	if (cached === null) cached = loadHealth();
	return { ...cached };
}

export function setHealthActive(): void {
	const now = new Date().toISOString();
	cached = { lastActive: now, status: "active" };
	mkdirSync(dirname(HEALTH_FILE), { recursive: true });
	writeFileSync(HEALTH_FILE, JSON.stringify(cached, null, 2), "utf-8");
}

export function setHealthIdle(): void {
	cached = { ...getHealth(), status: "idle" };
	mkdirSync(dirname(HEALTH_FILE), { recursive: true });
	writeFileSync(HEALTH_FILE, JSON.stringify(cached, null, 2), "utf-8");
}
