/** Políticas: seguridad, límites, condiciones de parada. */

export const policies = {
	maxStepsPerRun: 30,
	maxToolCallsPerStep: 5,
	stopOnUserQuestion: true,
	requireConfirmationForSystemWrite: true,
};

export function shouldStop(reason: string): boolean {
	const r = reason.toLowerCase();
	if (r.includes("cancel") || r.includes("stop") || r.includes("abort")) return true;
	return false;
}
