import { currentAgentRun } from "../../agent/runContext.js";
import { createDrawing, type DrawSpec } from "../../drawings/drawings.js";

/**
 * draw: un diagrama o infografía de Excalidraw. El modelo da cajas y flechas y `drawings.ts` las
 * acomoda. El dibujo sale en el chat (el id va en el paso, como `undo`) y queda en `Dibujos/`.
 */
export async function executeDraw(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const spec = args as unknown as DrawSpec;
	try {
		const d = createDrawing(spec);
		const ctx = currentAgentRun();
		if (ctx) ctx.drawing = d.id;
		const where = d.file.endsWith(".md") ? "en tu bóveda de Obsidian" : "en la carpeta de Aku";
		return {
			ok: true,
			content: `Dibujo «${d.title}» listo: el usuario ya lo ve en el chat y queda guardado ${where} como ${d.file}. No lo describas caja por caja; comenta solo lo importante.`,
		};
	} catch (err) {
		return { ok: false, content: `No pude guardar el dibujo: ${err instanceof Error ? err.message : String(err)}` };
	}
}
