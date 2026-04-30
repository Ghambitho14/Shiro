export type PlanStep = {
	id: string;
	goal: string;
};

export type ExecutionPlan = {
	id: string;
	goal: string;
	steps: PlanStep[];
};

/**
 * Planner mínimo: mantiene un contrato explícito de planificación
 * sin cambiar el comportamiento funcional del agente.
 */
export function createExecutionPlan(goal: string): ExecutionPlan {
	const normalizedGoal = String(goal ?? "").trim() || "Responder al usuario";
	return {
		id: `plan_${Date.now()}`,
		goal: normalizedGoal,
		steps: [
			{
				id: "step_1",
				goal: normalizedGoal,
			},
		],
	};
}
