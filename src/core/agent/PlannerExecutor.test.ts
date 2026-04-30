import { test } from "node:test";
import { strictEqual } from "node:assert";
import { createExecutionPlan } from "./Planner.js";
import { executePlannedSteps } from "./PlanExecutor.js";

test("createExecutionPlan genera un paso inicial con el goal", () => {
	const plan = createExecutionPlan("Analiza el proyecto");
	strictEqual(plan.steps.length, 1);
	strictEqual(plan.steps[0].goal, "Analiza el proyecto");
});

test("executePlannedSteps ejecuta los pasos en orden", async () => {
	const visited: string[] = [];
	const content = await executePlannedSteps(
		[
			{ id: "step_1", goal: "Paso 1" },
			{ id: "step_2", goal: "Paso 2" },
		],
		async (step) => {
			visited.push(step.id);
			return step.goal;
		},
	);
	strictEqual(visited.join(","), "step_1,step_2");
	strictEqual(content, "Paso 2");
});
