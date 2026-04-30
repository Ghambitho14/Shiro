import type { PlanStep } from "./Planner.js";

export type PlannedStepRunner = (step: PlanStep) => Promise<string>;

export async function executePlannedSteps(
	steps: PlanStep[],
	runStep: PlannedStepRunner,
): Promise<string> {
	let last = "";
	for (const step of steps) {
		last = await runStep(step);
	}
	return last;
}
