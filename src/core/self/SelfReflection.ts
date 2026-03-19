/**
 * Auto-Reflexión - Shiro se analiza y mejora a sí mismo
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "data");
const REFLECTION_FILE = join(DATA_DIR, "reflections.json");

interface Reflection {
	id: string;
	timestamp: string;
	trigger: string;
	analysis: string;
	suggestions: string[];
	implemented: boolean;
	applied?: string;
}

function loadReflections(): Reflection[] {
	if (!existsSync(REFLECTION_FILE)) return [];
	try {
		return JSON.parse(readFileSync(REFLECTION_FILE, "utf-8"));
	} catch {
		return [];
	}
}

function saveReflections(reflections: Reflection[]): void {
	writeFileSync(REFLECTION_FILE, JSON.stringify(reflections, null, 2), "utf-8");
}

export function addReflection(trigger: string, analysis: string, suggestions: string[]): Reflection {
	const reflections = loadReflections();
	
	const reflection: Reflection = {
		id: `ref_${Date.now()}`,
		timestamp: new Date().toISOString(),
		trigger,
		analysis,
		suggestions,
		implemented: false,
	};
	
	reflections.push(reflection);
	saveReflections(reflections);
	
	return reflection;
}

export function listReflections(): Reflection[] {
	return loadReflections().slice(-10).reverse();
}

export function getPendingReflections(): Reflection[] {
	return loadReflections().filter(r => !r.implemented);
}

export function markReflectionImplemented(id: string, applied?: string): Reflection | undefined {
	const reflections = loadReflections();
	const reflection = reflections.find(r => r.id === id);
	
	if (!reflection) return undefined;
	
	reflection.implemented = true;
	reflection.applied = applied || new Date().toISOString();
	saveReflections(reflections);
	
	return reflection;
}

/**
 * Analiza el código de Shiro y sugiere mejoras
 */
export async function selfAnalyze(): Promise<string> {
	const srcDir = join(__dirname, "..", "..");
	
	const files = readdirSync(srcDir, { recursive: true })
		.filter(f => typeof f === "string" && f.endsWith(".ts") && !f.includes("node_modules"))
		.slice(0, 30);
	
	let analysis = `📊 Auto-análisis de Shiro\n\n`;
	analysis += `Archivos fuente: ${files.length}\n\n`;
	
	// Contar líneas de código
	let totalLines = 0;
	for (const file of files.slice(0, 10)) {
		const path = join(srcDir, file as string);
		if (existsSync(path)) {
			const content = readFileSync(path, "utf-8");
			totalLines += content.split("\n").length;
		}
	}
	
	analysis += `Líneas de código (sample): ~${totalLines}\n\n`;
	analysis += `✅ Sistema de reflexión activo\n`;
	analysis += `✅ Policies de autonomía: ${loadReflections().length} reflexiones guardadas\n`;
	analysis += `✅ Herramientas: ${files.filter(f => (f as string).includes("tools")).length} archivos de tools\n`;
	
	return analysis;
}

/**
 * Generación de insights basado en patrones
 */
export function generateInsight(pattern: string): string {
	const insights: Record<string, string> = {
		"error_repeat": "Los errores se repiten - considera añadir validación previa",
		"tool_failure": "Una tool falló varias veces - maybe necesita más contexto",
		"memory_gap": "El agente no recordó info previa - revisar políticas de memoria",
		"slow_response": "Las respuestas son lentas - maybe usar modelos más rápidos",
	};
	
	return insights[pattern] || "Patrón no reconocido";
}