import { useSkill } from "../../skills/SkillLoader.js";

/** use_skill: lista las habilidades, carga una o lee un archivo suyo (solo lectura). */
export async function executeUseSkill(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const name = typeof args.name === "string" ? args.name : undefined;
	const file = typeof args.file === "string" ? args.file : undefined;
	try {
		return useSkill(name, file);
	} catch (err) {
		return { ok: false, content: `No pude leer la habilidad: ${err instanceof Error ? err.message : String(err)}` };
	}
}
