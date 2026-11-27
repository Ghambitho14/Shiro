// Datos de un modelo en una frase para Ajustes → Modelo (desplegable de modelForm.js y panel de llamacpp.js):
// "8B · Q4_K_M · 4,9 GB · cabe en tu tarjeta (RTX 3060, 12 GB)" o "0,15 $ / 0,60 $ por millón de tokens".
// Los datos vienen de src/core/llm/modelInfo.ts por /api/models y /api/llamacpp.

const GB = 1024 ** 3;

const fmt = (n, digits = 1) => n.toLocaleString("es", { maximumFractionDigits: digits });

/** Tamaño en GB (o MB si es chico). */
export function formatSize(bytes) {
	return bytes >= GB ? `${fmt(bytes / GB)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** 131072 y 128000 → "128K"; 1048576 y 1000000 → "1M". Los proveedores usan unas u otras (1024 o 1000). */
function formatContext(tokens) {
	const k = tokens % 1000 === 0 ? 1000 : 1024;
	if (tokens >= k * k) return `${fmt(tokens / (k * k))}M`;
	return tokens >= k ? `${Math.round(tokens / k)}K` : String(tokens);
}

/** "RTX 3060" de "NVIDIA GeForce RTX 3060". */
const shortGpu = (name) => String(name || "").replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "");

/**
 * La frase de un modelo y su tono: `{ text, kind }` con kind "ok" (cabe), "warn" (justo o no cabe) o ""
 * (solo datos). Texto vacío si no se sabe nada.
 */
export function describeModel(m, gpu) {
	if (!m) return { text: "", kind: "" };
	const parts = [];
	if (m.params) parts.push(m.params);
	if (m.quant) parts.push(m.quant);
	if (m.sizeBytes) parts.push(`${m.sizeEstimated ? "≈" : ""}${formatSize(m.sizeBytes)}`);
	if (m.context) parts.push(`${formatContext(m.context)} de contexto`);
	let kind = "";
	if (m.fit && gpu) {
		const card = `${shortGpu(gpu.name)}, ${formatSize(gpu.vramBytes)}`;
		if (m.fit === "fits") {
			parts.push(`cabe en tu tarjeta (${card})`);
			kind = "ok";
		} else if (m.fit === "tight") {
			parts.push(`justo en tu tarjeta (${card}): queda poco sitio para la conversación`);
			kind = "warn";
		} else {
			parts.push(`no cabe en tu tarjeta (${card}): una parte irá al procesador y responderá más lento`);
			kind = "warn";
		}
	}
	if (m.price) {
		const { input, output } = m.price;
		parts.push(input === 0 && output === 0 ? "gratis" : `${fmt(input, 3)} $ leídos · ${fmt(output, 3)} $ escritos por millón de tokens`);
	}
	return { text: parts.join(" · "), kind };
}
