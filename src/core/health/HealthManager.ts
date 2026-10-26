/** Última actividad del asistente (la usa /api/health para saber si Shiro está en uso). */
let lastActive = new Date().toISOString();

export function setHealthActive(): void {
	lastActive = new Date().toISOString();
}

export function getLastActive(): string {
	return lastActive;
}
