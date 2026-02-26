/** Contadores para telemetría y health. */
export const metrics = {
	toolCalls: 0,
	errors: 0,
	replans: 0,
	loopInterventions: 0,
};

export function resetMetrics(): void {
	metrics.toolCalls = 0;
	metrics.errors = 0;
	metrics.replans = 0;
	metrics.loopInterventions = 0;
}
