/** Verificador de objetivos y pasos del planner. */

export type VerificationResult = { valid: boolean; reason?: string };

/** Valida que un paso del planner sea ejecutable y coherente. */
export function verifyStep(step: string): VerificationResult {
	const trimmed = step.trim();
	if (!trimmed || trimmed.length < 3) {
		return { valid: false, reason: "Paso vacío o muy corto" };
	}

	const tooLong = trimmed.length > 500;
	if (tooLong) {
		return { valid: false, reason: "Paso demasiado largo (máx 500 caracteres)" };
	}

	const forbidden = [
		"eliminar sistema",
		"borrar disco",
		"formatear",
		"rm -rf /",
		"del *",
		"remove *",
		"delete system",
	];
	const lower = trimmed.toLowerCase();
	for (const bad of forbidden) {
		if (lower.includes(bad)) {
			return { valid: false, reason: `Paso contiene comando peligroso: ${bad}` };
		}
	}

	return { valid: true };
}

/** Valida una lista de pasos antes de ejecutarlos. */
export function verifyPlan(steps: string[]): { valid: boolean; validSteps: string[]; invalidReasons: string[] } {
	if (steps.length === 0) {
		return { valid: false, validSteps: [], invalidReasons: ["El plan no tiene pasos"] };
	}

	if (steps.length > 10) {
		return { valid: false, validSteps: [], invalidReasons: ["El plan tiene demasiados pasos (máx 10)"] };
	}

	const validSteps: string[] = [];
	const invalidReasons: string[] = [];

	for (let i = 0; i < steps.length; i++) {
		const result = verifyStep(steps[i]);
		if (result.valid) {
			validSteps.push(steps[i]);
		} else {
			invalidReasons.push(`Paso ${i + 1}: ${result.reason}`);
		}
	}

	return {
		valid: validSteps.length > 0,
		validSteps,
		invalidReasons,
	};
}

/** Verifica si el objetivo se cumplió con el resultado. */
export function verifyGoal(goal: string, result: string): { satisfied: boolean; reason?: string } {
	if (!result || result.length < 2) {
		return { satisfied: false, reason: "Sin respuesta" };
	}

	const lowerGoal = goal.toLowerCase();
	const lowerResult = result.toLowerCase();

	const hasQuestion = lowerGoal.includes("?") || lowerGoal.includes("qué") || lowerGoal.includes("como");
	if (hasQuestion && lowerResult.length > 10) {
		return { satisfied: true };
	}

	const actionWords = ["leído", "escrito", "creado", "buscado", "listado", "obtenido", "resuelto"];
	const hasActionResult = actionWords.some((w) => lowerResult.includes(w));
	if (hasActionResult) {
		return { satisfied: true };
	}

	return { satisfied: lowerResult.length > 5 };
}
