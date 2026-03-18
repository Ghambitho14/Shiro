import type { ToolDefinition } from "../ToolRegistry.js";

export const getTimeTool: ToolDefinition = {
	label: "Obtener Hora",
	name: "get_time",
	description: "Obtiene la fecha y hora actual.",
	category: "utilidades",
	parameters: {
		type: "object",
		properties: { timezone: { type: "string", description: "Zona horaria opcional" } },
	},
};

export async function executeGetTime(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const timezone = args.timezone ? String(args.timezone).trim() : undefined;
	let date: Date;
	try {
		date = timezone ? new Date(new Date().toLocaleString("en-US", { timeZone: timezone })) : new Date();
	} catch {
		return { ok: false, content: "Zona horaria inválida" };
	}

	const iso = date.toISOString();
	const local = date.toLocaleString("es-ES", { timeZone: timezone });
	const utc = date.toUTCString();

	return { ok: true, content: `Fecha: ${local}\nUTC: ${utc}\nISO: ${iso}` };
}
