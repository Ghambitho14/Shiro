/**
 * Tool: git - Ejecuta comandos git en el repositorio
 */

import { registerToolExecutor } from "../../toolExecutors.js";
import { spawn } from "node:child_process";

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

	const trimmed = command.trim();
	if (!trimmed) return { ok: false, content: "Comando vacío" };

	// Evita inyección por shell metacharacters.
	if (/[;&|`$<>]/.test(trimmed)) {
		return { ok: false, content: "Comando no permitido: contiene caracteres peligrosos" };
	}

	const [subcommandRaw, ...rest] = trimmed.split(/\s+/);
	const subcommand = subcommandRaw.toLowerCase();
	const allowed = new Set([
		"status",
		"log",
		"diff",
		"show",
		"branch",
		"rev-parse",
		"remote",
		"tag",
	]);
	if (!allowed.has(subcommand)) {
		return { ok: false, content: `Subcomando git no permitido: ${subcommand}` };
	}
	
	try {
		const result = await new Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>((resolve) => {
			const child = spawn("git", [subcommand, ...rest], {
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (d) => (stdout += String(d)));
			child.stderr.on("data", (d) => (stderr += String(d)));
			child.on("error", (err) => resolve({ ok: false, stdout, stderr, error: err.message }));
			child.on("close", (code) => {
				if (code === 0) resolve({ ok: true, stdout, stderr });
				else resolve({ ok: false, stdout, stderr, error: `git ${subcommand} terminó con código ${code}` });
			});
		});
		
		if (!result.ok) {
			const detail = [result.error, result.stderr.trim()].filter(Boolean).join("\n");
			return { ok: false, content: `Error ejecutando git ${trimmed}:\n${detail || "sin detalles"}` };
		}
		
		let output = result.stdout.trim();
		if (result.stderr.trim()) output += `\n\n[stderr]: ${result.stderr.trim()}`;
		return { ok: true, content: output || "(sin salida)" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { 
			ok: false, 
			content: `Error ejecutando git ${trimmed}:\n${message}` 
		};
	}
}

registerToolExecutor("git", executeGit);
