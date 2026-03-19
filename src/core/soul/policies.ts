/** Políticas de autonomía: seguridad, límites, comportamiento autónomo */

export const policies = {
	// Límites de ejecución
	maxStepsPerRun: 30,
	maxToolCallsPerStep: 5,
	maxRetriesPerTool: 3,
	
	// Comportamiento autónomo
	autoMemorySave: true,        // Auto-guardar decisiones importantes en memoria
	autoCorrection: true,        // Auto-corregir errores sin pedir al usuario
	proactiveMode: false,        // puede actuar sin preguntar (requiere enabled explicit)
	
	// Seguridad
	confirmCriticalActions: true, // Pedir confirmación para writes/deletes dangerous
	requireConfirmationForSystemWrite: true,
	allowExec: true,             // Permitir ejecución de comandos
	allowCron: true,             // Permitir tareas programadas
	
	// Stop conditions
	stopOnUserQuestion: true,
	stopOnError: false,          // Continue despite errors (con maxRetries)
	
	// Auto-save triggers (qué guardar automáticamente)
	autoSaveDecisions: true,    // Guardar decisiones importantes
	autoSaveInsights: true,     // Guardar aprendizajes
	autoSaveErrors: false,      // Guardar errores para evitar repetirlos
	
	// Rate limiting
	rateLimitPerMinute: 60,     // Max tool calls por minuto
	rateLimitPerHour: 500,      // Max tool calls por hora
};

export function shouldStop(reason: string): boolean {
	const r = reason.toLowerCase();
	if (r.includes("cancel") || r.includes("stop") || r.includes("abort")) return true;
	if (r.includes("done") || r.includes("complete") || r.includes("finished")) return true;
	return false;
}

/** Verifica si una acción requiere confirmación del usuario */
export function requiresConfirmation(action: string): boolean {
	const criticalActions = [
		"write_file_system",
		"exec",
		"delete",
		"remove",
		"rm ",
		"format",
		"drop",
	];
	return policies.confirmCriticalActions && criticalActions.some(a => action.toLowerCase().includes(a));
}

/** Decides si debemos guardar esta interacción en memoria */
export function shouldAutoSave(eventType: string, content: string): boolean {
	if (!policies.autoMemorySave) return false;
	
	const importantTypes = ["decision", "observation", "tool_call"];
	if (!importantTypes.includes(eventType)) return false;
	
	const importantKeywords = [
		"decisión", "decision", "importante", "remember",
		"no olvidar", "don't forget", "guardar", "save",
		"aprendido", "learned", "insight", "mejorar", "improve"
	];
	
	return importantKeywords.some(k => content.toLowerCase().includes(k));
}
