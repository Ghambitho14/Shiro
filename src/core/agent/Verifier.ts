/** Opcional: verifica si el objetivo se cumplió. Por ahora no hace nada. */
export function verifyGoal(goal: string, result: string): { satisfied: boolean; reason?: string } {
	if (!result || result.length < 2) {
		return { satisfied: false, reason: "Sin respuesta" };
	}
	return { satisfied: true };
}
