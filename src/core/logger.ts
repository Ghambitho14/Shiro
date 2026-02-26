type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Level[] = ["debug", "info", "warn", "error"];
let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
	minLevel = level;
}

function shouldLog(level: Level): boolean {
	return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(minLevel);
}

function log(level: Level, msg: string, data?: Record<string, unknown>): void {
	if (!shouldLog(level)) return;
	const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
	if (data && Object.keys(data).length > 0) {
		console.log(prefix, msg, data);
	} else {
		console.log(prefix, msg);
	}
}

export const logger = {
	debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
	info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
	warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
	error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
