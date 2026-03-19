/**
 * Tool: self_analyze - Analiza el propio codigo
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const selfAnalyzeTool = {
	name: "self_analyze",
	description: "Analiza el propio codigo de Shiro para entender su estado actual y sugiere mejoras.",
	category: "self",
	parameters: {
		type: "object",
		properties: {},
	},
};

async function executeSelfAnalyze(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { selfAnalyze } = await import("../../../self/SelfReflection.js");
	const result = await selfAnalyze();
	return { ok: true, content: result };
}

registerToolExecutor("self_analyze", executeSelfAnalyze);
