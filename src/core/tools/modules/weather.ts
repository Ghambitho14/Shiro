import type { ToolDefinition } from "../ToolRegistry.js";

export const getWeatherTool: ToolDefinition = {
	label: "Obtener Clima",
	name: "get_weather",
	description: "Obtiene el clima actual de una ciudad.",
	category: "utilidades",
	parameters: {
		type: "object",
		properties: { city: { type: "string", description: "Nombre de la ciudad" } },
		required: ["city"],
	},
};

export async function executeGetWeather(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const city = String(args.city ?? "").trim();
	if (!city) return { ok: false, content: "El nombre de la ciudad es requerido" };

	const WEATHER_API = `https://wttr.in/${encodeURIComponent(city)}?format=%c%t+%h+%p+%w&lang=es`;
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 10000);

	try {
		const res = await fetch(WEATHER_API, { signal: controller.signal });
		clearTimeout(timeoutId);

		if (!res.ok) return { ok: false, content: `Error al obtener clima: ${res.status}` };

		const text = await res.text();
		const lines = text.trim().split("\n");

		let temp = "", humidity = "", precip = "", wind = "";
		for (const line of lines) {
			if (line.includes("°C") || line.includes("°F")) temp = line.trim();
			else if (line.includes("%")) humidity = line.trim();
			else if (line.includes("mm") || line.includes("cm")) precip = line.trim();
			else if (line.includes("km/h") || line.includes("mph")) wind = line.trim();
		}

		let result = `🌤️ Clima en ${city}:\n`;
		if (temp) result += `   Temperatura: ${temp}\n`;
		if (humidity) result += `   Humedad: ${humidity}\n`;
		if (precip) result += `   Precipitación: ${precip}\n`;
		if (wind) result += `   Viento: ${wind}\n`;
		result += "\n   Fuente: wttr.in";

		return { ok: true, content: result };
	} catch (e) {
		clearTimeout(timeoutId);
		if (e instanceof Error && e.name === "AbortError") {
			return { ok: false, content: "Timeout al obtener clima" };
		}
		return { ok: false, content: e instanceof Error ? e.message : String(e) };
	}
}
