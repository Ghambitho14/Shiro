/**
 * Tool: git - Ejecuta comandos git en el repositorio
 */

import { registerToolExecutor } from "../../toolExecutors.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const gitTool = {
	name: "git",
	description: "Ejecuta comandos git en el repositorio",
	category: "meta",
	parameters: {
		type: "object",
		properties: {
			command: {
				type: "string",
				description: "Comando git a ejecutar (ej: 'status', 'log --oneline -5', 'diff')"
			}
		},
		required: ["command"]
	},
	examples: [
		'"qué cambios hay" -> git({ command: "status" })',
		'"muestra el log" -> git({ command: "log --oneline -10" })',
	],
};

async function executeGit(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const command = args.command as string;
	
	if (!command) {
		return { ok: false, content: "Falta el parámetro: command" };
	}
	
	try {
		const { stdout, stderr } = await execAsync(`git ${command}`, {
			cwd: process.cwd(),
			maxBuffer: 1024 * 1024
		});
		
		let output = stdout.trim();
		if (stderr.trim()) {
			output += `\n\n[stderr]: ${stderr.trim()}`;
		}
		
		return { ok: true, content: output || "(sin salida)" };
	} catch (error: any) {
		return { 
			ok: false, 
			content: `Error ejecutando git ${command}:\n${error.message}` 
		};
	}
}

registerToolExecutor("git", executeGit);
