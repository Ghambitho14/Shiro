/**
 * Confirmation Manager - Decide si debe preguntar antes de actuar
 */

export type ActionType = 
	| "create_file" 
	| "execute_code" 
	| "modify_code" 
	| "delete" 
	| "git_commit"
	| "create_mcp"
	| "install_package"
	| "modify_config";

export interface ActionContext {
	type: ActionType;
	userRequest: string;
	hasClearPurpose: boolean;
	isDangerous: boolean;
	canProceed: boolean;
	question?: string;
}

const CONTEXT_QUESTIONS: Record<ActionType, (req: string) => string | null> = {
	create_file: (req) => {
		const hasExt = /\.\w+$/.test(req);
		if (!hasExt) return "¿Qué tipo de archivo necesitas? (script, documento, config, etc.)";
		return null;
	},
	
	execute_code: (req) => {
		const hasPath = /\//.test(req) || /:\\/.test(req);
		if (!hasPath) return "¿Qué archivo o comando quieres ejecutar?";
		return null;
	},
	
	modify_code: (req) => {
		if (req.includes("bug") || req.includes("error")) return "¿Qué error estás viendo?";
		if (req.includes("refactor")) return "¿Qué parte del código quieres refactorizar?";
		return null;
	},
	
	delete: () => "Estás seguro de que quieres eliminar esto? No se puede deshacer.",
	
	git_commit: () => "¿Qué cambios estás guardando? Dame un resumen.",
	
	create_mcp: (req) => {
		return "¿Para qué necesitas el MCP? ¿Qué funcionalidad específica quieres que tenga?";
	},
	
	install_package: () => "¿Qué paquete necesitas y por qué?",
	
	modify_config: () => "¿Qué configuración quieres cambiar y por qué?",
};

export function needsConfirmation(action: ActionType, userRequest: string): ActionContext {
	const questionFn = CONTEXT_QUESTIONS[action];
	const question = questionFn ? questionFn(userRequest) : null;
	
	const dangerousActions: ActionType[] = ["delete", "git_commit"];
	
	const context: ActionContext = {
		type: action,
		userRequest,
		hasClearPurpose: question === null,
		isDangerous: dangerousActions.includes(action),
		canProceed: question === null,
		question: question ?? undefined,
	};
	
	return context;
}

export function detectActionType(request: string): ActionType {
	const lower = request.toLowerCase();
	
	if (lower.includes("mcp") || lower.includes("máquina de comando")) return "create_mcp";
	if (lower.includes("crea") || lower.includes("genera") || lower.includes("make") || lower.includes("build")) return "create_file";
	if (lower.includes("ejecuta") || lower.includes("run") || lower.includes("corre")) return "execute_code";
	if (lower.includes("modifica") || lower.includes("cambia") || lower.includes("arregla") || lower.includes("fix")) return "modify_code";
	if (lower.includes("elimina") || lower.includes("borra") || lower.includes("delete")) return "delete";
	if (lower.includes("commit") || lower.includes("guardar cambios")) return "git_commit";
	if (lower.includes("instala") || lower.includes("install") || lower.includes("npm")) return "install_package";
	if (lower.includes("config") || lower.includes("configuración")) return "modify_config";
	
	return "create_file"; // Default
}

export function formatConfirmationResponse(context: ActionContext): string {
	if (!context.question) return "";
	
	return `\n\n**Antes de hacerlo:** ${context.question}`;
}