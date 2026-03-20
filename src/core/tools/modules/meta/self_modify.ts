/**
 * Tool: self_modify - Modifica el propio código de Shiro
 */

import { registerToolExecutor } from "../../toolExecutors.js";
import * as fs from "fs";
import * as path from "path";

export const selfModifyTool = {
	name: "self_modify",
	description: "Modifica el propio código de Shiro. Usa esto cuando quieras cambiar cómo funcionas.",
	category: "meta",
	parameters: {
		type: "object",
		properties: {
			file: {
				type: "string",
				description: "Ruta del archivo a modificar (relativa al proyecto)"
			},
			search: {
				type: "string",
				description: "El texto exacto que quieres reemplazar"
			},
			replace: {
				type: "string",
				description: "El nuevo texto que quieres poner"
			}
		},
		required: ["file", "search"]
	},
	examples: [
		'"cambia el prompt del sistema" -> self_modify({ file: "src/core/soul/soul.ts", search: "...", replace: "..." })',
	],
};

async function executeSelfModify(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const file = args.file as string;
	const search = (args.search as string) ?? (args.oldString as string);
	const replace = (args.replace as string) ?? (args.newString as string) ?? "";
	
	if (!file || !search) {
		return { ok: false, content: "Faltan parámetros: file, search" };
	}

	// Seguridad: solo permite modificar archivos dentro de src/ del proyecto.
	if (path.isAbsolute(file) || file.includes("..")) {
		return { ok: false, content: "Ruta inválida. Usa una ruta relativa dentro de src/." };
	}
	if (!file.startsWith("src/") && !file.startsWith("src\\")) {
		return { ok: false, content: "Solo se permite modificar archivos dentro de src/." };
	}
	const repoRoot = process.cwd();
	const allowedRoot = path.resolve(repoRoot, "src");
	const filePath = path.resolve(repoRoot, file);
	const allowedRootWithSep = allowedRoot.endsWith(path.sep) ? allowedRoot : allowedRoot + path.sep;
	if (!(filePath === allowedRoot || filePath.startsWith(allowedRootWithSep))) {
		return { ok: false, content: "Ruta fuera del alcance permitido (src/)." };
	}
	
	if (!fs.existsSync(filePath)) {
		return { ok: false, content: `Archivo no encontrado: ${file}` };
	}
	
	let content = fs.readFileSync(filePath, "utf-8");
	
	if (!content.includes(search)) {
		return { 
			ok: false, 
			content: `No encontré el texto a reemplazar en ${file}. Asegúrate de copiar exactamente el texto a cambiar.` 
		};
	}

	if (!replace) {
		return { ok: true, content: `✅ Encontrado texto en ${file}. No se aplicó reemplazo porque 'replace' está vacío.` };
	}
	content = content.replace(search, replace);
	fs.writeFileSync(filePath, content, "utf-8");
	return { ok: true, content: `✅ Modificado exitosamente: ${file}` };
}

registerToolExecutor("self_modify", executeSelfModify);
