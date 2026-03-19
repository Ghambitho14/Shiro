/**
 * Tool: project_analyze - Analiza la estructura del proyecto
 */

import { registerToolExecutor } from "../../toolExecutors.js";
import * as fs from "fs";
import * as path from "path";

export const projectAnalyzeTool = {
	name: "project_analyze",
	description: "Analiza la estructura del proyecto actual y retorna un resumen",
	category: "meta",
	parameters: {
		type: "object",
		properties: {
			depth: {
				type: "string",
				enum: ["quick", "medium", "deep"],
				description: "Nivel de profundidad del análisis",
				default: "medium"
			}
		}
	},
	examples: [
		'"analiza mi proyecto" -> project_analyze({})',
		'"qué estructura tiene" -> project_analyze({})',
	],
};

async function executeProjectAnalyze(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const depth = (args.depth as string) || "medium";
	
	const analyzeDir = (dir: string, maxDepth: number, currentDepth = 0): any => {
		if (currentDepth >= maxDepth) return "...";
		
		const items: Record<string, any> = {};
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			
			for (const entry of entries) {
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				
				const fullPath = path.join(dir, entry.name);
				
				if (entry.isDirectory()) {
					items[entry.name + "/"] = analyzeDir(fullPath, maxDepth, currentDepth + 1);
				} else {
					const ext = path.extname(entry.name);
					if (depth === "deep" || [".ts", ".js", ".json", ".md"].includes(ext)) {
						items[entry.name] = ext;
					}
				}
			}
		} catch {
			return "error";
		}
		
		return items;
	};
	
	const structure = analyzeDir(process.cwd(), depth === "quick" ? 2 : depth === "medium" ? 3 : 5);
	
	try {
		const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
		
		return {
			ok: true,
			content: `Proyecto: ${packageJson.name} v${packageJson.version}\n\nEstructura:\n${JSON.stringify(structure, null, 2)}`
		};
	} catch {
		return {
			ok: true,
			content: `Estructura:\n${JSON.stringify(structure, null, 2)}`
		};
	}
}

registerToolExecutor("project_analyze", executeProjectAnalyze);
