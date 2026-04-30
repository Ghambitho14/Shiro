import { DEV_PROMPT } from "./modes/dev.js";
import { ANALYST_PROMPT } from "./modes/analyst.js";
import { HACKER_PROMPT } from "./modes/hacker.js";

export type Role = "default" | "dev" | "analyst" | "hacker";

export type RoleConfig = {
	name: string;
	description: string;
	prompt: string;
	allowedTools?: string[];
};

const ROLES: Record<Role, RoleConfig> = {
	default: {
		name: "General",
		description: "Asistente conversacional útil y amigable",
		prompt: "",
		allowedTools: undefined,
	},
	dev: {
		name: "Desarrollador",
		description: "Especializado en desarrollo de software",
		prompt: DEV_PROMPT,
		allowedTools: [
			"read_file",
			"write_file",
			"list_dir",
			"read_file_system",
			"write_file_system",
			"list_dir_system",
			"exec",
			"git",
			"self_modify",
			"self_analyze",
			"fetch_url",
			"search_web",
		],
	},
	analyst: {
		name: "Analista",
		description: "Especializado en análisis de datos y logs",
		prompt: ANALYST_PROMPT,
		allowedTools: [
			"read_file",
			"read_file_system",
			"list_dir",
			"list_dir_system",
			"calculator",
			"exec",
			"search_web",
		],
	},
	hacker: {
		name: "Pentester",
		description: "Especializado en seguridad y pentesting",
		prompt: HACKER_PROMPT,
		allowedTools: [
			"read_file",
			"read_file_system",
			"exec",
			"git",
			"search_web",
			"fetch_url",
		],
	},
};

export function getRole(role: Role): RoleConfig {
	return ROLES[role] ?? ROLES.default;
}

export function getRolePrompt(role: Role): string {
	const config = getRole(role);
	if (!config.prompt) return "";
	return config.prompt;
}

export function getAllowedTools(role: Role): string[] | undefined {
	return getRole(role).allowedTools;
}

export function listRoles(): Role[] {
	return Object.keys(ROLES) as Role[];
}