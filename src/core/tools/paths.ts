import { resolve } from "node:path";

/** Ruta absoluta para comparar (en Windows sin distinguir mayúsculas). */
export function normalizeForCompare(pathValue: string): string {
	const resolved = resolve(pathValue);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** true si pathValue está dentro de rootValue (con allowRoot, también si es la propia raíz). */
export function isWithinRoot(pathValue: string, rootValue: string, allowRoot = false): boolean {
	const pathNormalized = normalizeForCompare(pathValue);
	const rootNormalized = normalizeForCompare(rootValue);
	if (pathNormalized === rootNormalized) return allowRoot;
	const sep = process.platform === "win32" ? "\\" : "/";
	const boundaryRoot = rootNormalized.endsWith(sep) ? rootNormalized : rootNormalized + sep;
	return pathNormalized.startsWith(boundaryRoot);
}
