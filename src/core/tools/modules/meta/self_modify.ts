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
			oldString: {
				type: "string",
				description: "El texto exacto que quieres reemplazar"
			},
			newString: {
				type: "string",
				description: "El nuevo texto que quieres poner"
			}
		},
		required: ["file", "oldString", "newString"]
	},
	examples: [
		'"cambia el prompt del sistema" -> self_modify({ file: "src/core/soul/soul.ts", oldString: "...", newString: "..." })',
	],
};

async function executeSelfModify(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const file = args.file as string;
	const oldString = args.oldString as string;
	const newString = args.newString as string;
	
	if (!file || !oldString || !newString) {
		return { ok: false, content: "Faltan parámetros: file, oldString, newString" };
	}
	
	const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
	
	if (!fs.existsSync(filePath)) {
		return { ok: false, content: `Archivo no encontrado: ${file}` };
	}
	
	let content = fs.readFileSync(filePath, "utf-8");
	
	if (!content.includes(oldString)) {
		return { 
			ok: false, 
			content: `No encontré el texto a reemplazar en ${file}. Asegúrate de copiar exactamente el texto a cambiar.` 
		};
	}
	
	content = content.replace(oldString, newString);
	fs.writeFileSync(filePath, content, "utf-8");
	
	return { 
		ok: true, 
		content: `✅ Modificado exitosamente: ${file}\n\nEl cambio ha sido aplicado. Es posible que necesites reiniciar Shiro para ver los cambios.` 
	};
}

registerToolExecutor("self_modify", executeSelfModify);
