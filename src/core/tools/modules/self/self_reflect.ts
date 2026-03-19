/**
 * Tool: self_reflect - Lista reflexiones
 */

import { registerToolExecutor } from "../../toolExecutors.js";

export const selfReflectTool = {
	name: "self_reflect",
	description: "Lista las reflexiones previas del sistema, insights generados, y sugerencias de mejora pendientes.",
	category: "self",
	parameters: {
		type: "object",
		properties: {
			pending: { type: "boolean", description: "Solo mostrar pendientes (default: false)" },
		},
	},
};

async function executeSelfReflect(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const { listReflections, getPendingReflections } = await import("../../../self/SelfReflection.js");
	const pendingOnly = args.pending === true;
	
	const reflections = pendingOnly ? getPendingReflections() : listReflections();
	
	if (reflections.length === 0) {
		return { ok: true, content: "No hay reflexiones registradas." };
	}
	
	let output = pendingOnly ? "Reflexiones pendientes:\n\n" : "Historial de reflexiones:\n\n";
	
	for (const r of reflections) {
		const status = r.implemented ? "✅" : "⏳";
		output += `${status} [${r.timestamp.slice(0, 10)}] ${r.trigger}\n`;
		output += `   ${r.analysis.slice(0, 80)}...\n`;
		if (r.suggestions.length > 0) {
			output += `   💡 ${r.suggestions[0].slice(0, 60)}...\n`;
		}
		output += "\n";
	}
	
	return { ok: true, content: output };
}

registerToolExecutor("self_reflect", executeSelfReflect);
