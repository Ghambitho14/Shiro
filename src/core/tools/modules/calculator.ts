import type { ToolDefinition } from "../ToolRegistry.js";

export const calculatorTool: ToolDefinition = {
	label: "Calculadora",
	name: "calculator",
	description: "Calcula operaciones matemáticas.",
	category: "utilidades",
	parameters: {
		type: "object",
		properties: { expression: { type: "string", description: "Expresión (ej: 25 * 4, sqrt(144))" } },
		required: ["expression"],
	},
};

export async function executeCalculator(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const expression = String(args.expression ?? "").trim();
	if (!expression) return { ok: false, content: "Expresión requerida" };
	if (expression.length > 500) return { ok: false, content: "Expresión demasiado larga" };

	const dangerous = /[;|`$(){}\[\]\\]/;
	if (dangerous.test(expression)) {
		return { ok: false, content: "Expresión contiene caracteres no permitidos" };
	}

	try {
		const sanitized = expression
			.replace(/sqrt\(/gi, "Math.sqrt(")
			.replace(/pow\(/gi, "Math.pow(")
			.replace(/abs\(/gi, "Math.abs(")
			.replace(/floor\(/gi, "Math.floor(")
			.replace(/ceil\(/gi, "Math.ceil(")
			.replace(/round\(/gi, "Math.round(")
			.replace(/log\(/gi, "Math.log(")
			.replace(/exp\(/gi, "Math.exp(")
			.replace(/PI/gi, "Math.PI")
			.replace(/E/gi, "Math.E");

		const result = Function(`"use strict"; return (${sanitized})`)();
		if (typeof result !== "number") {
			return { ok: false, content: "El resultado no es un número" };
		}
		if (!isFinite(result)) {
			return { ok: false, content: "El resultado es infinito o indefinido" };
		}
		return { ok: true, content: String(result) };
	} catch {
		return { ok: false, content: "Expresión matemática inválida" };
	}
}
