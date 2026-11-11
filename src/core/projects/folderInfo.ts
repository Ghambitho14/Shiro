/**
 * Qué hay en una carpeta vinculada a un proyecto: qué tipo de programa es, con qué comandos se
 * comprueba, en qué rama de git está y dónde están sus reglas. Va en el system prompt para que el
 * modelo no tenga que averiguarlo ni preguntarlo. Solo mira archivos pequeños y nunca lanza.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type FolderInfo = {
	/** "Node/TypeScript (npm)", "Python", "Rust"… */
	kind?: string;
	/** Comandos para comprobar o arrancar, tal cual se escriben. */
	commands: string[];
	/** Rama de git, o "" si es un repositorio pero no se sabe la rama. */
	branch?: string;
	/** Archivos con las reglas del proyecto que existen (AGENTS.md, CLAUDE.md, README.md). */
	rules: string[];
	docker: boolean;
};

const CACHE_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const cache = new Map<string, { at: number; info: FolderInfo }>();

/** Scripts de package.json que sirven para comprobar o arrancar, en este orden. */
const USEFUL_SCRIPTS = ["check", "typecheck", "lint", "test", "build", "dev", "start"];
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];

function readSmall(file: string): string | null {
	try {
		if (statSync(file).size > MAX_JSON_BYTES) return null;
		return readFileSync(file, "utf-8");
	} catch {
		return null;
	}
}

function nodeInfo(dir: string, info: FolderInfo): void {
	const text = readSmall(join(dir, "package.json"));
	if (text === null) return;
	const has = (f: string) => existsSync(join(dir, f));
	const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
	info.kind = `Node${has("tsconfig.json") ? "/TypeScript" : ""} (${pm})`;
	try {
		const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
		for (const name of USEFUL_SCRIPTS) {
			if (typeof scripts[name] !== "string" || info.commands.length >= 5) continue;
			info.commands.push(name === "test" || name === "start" ? `${pm} ${name}` : `${pm} run ${name}`);
		}
	} catch {
		// package.json roto: se sabe que es Node, pero no sus comandos.
	}
}

function gitBranch(dir: string): string | undefined {
	const git = join(dir, ".git");
	if (!existsSync(git)) return undefined;
	// En un worktree o submódulo, .git es un archivo: es un repositorio, pero la rama está en otro sitio.
	const head = readSmall(join(git, "HEAD"));
	return /^ref: refs\/heads\/(.+)$/m.exec(head ?? "")?.[1]?.trim() ?? "";
}

export function describeFolder(dir: string): FolderInfo {
	const hit = cache.get(dir);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
	const info: FolderInfo = { commands: [], rules: [], docker: false };
	try {
		const has = (f: string) => existsSync(join(dir, f));
		nodeInfo(dir, info);
		if (!info.kind) {
			if (has("pyproject.toml") || has("requirements.txt")) {
				info.kind = "Python";
				if (has("tests") || /pytest/.test(readSmall(join(dir, "pyproject.toml")) ?? "")) info.commands.push("pytest");
			} else if (has("Cargo.toml")) {
				info.kind = "Rust";
				info.commands.push("cargo check", "cargo test");
			} else if (has("go.mod")) {
				info.kind = "Go";
				info.commands.push("go build ./...", "go test ./...");
			} else if (has("pom.xml")) info.kind = "Java (Maven)";
			else if (has("build.gradle") || has("build.gradle.kts")) info.kind = "Java/Kotlin (Gradle)";
			else if (has("composer.json")) info.kind = "PHP";
		}
		info.docker = has("Dockerfile") || has("docker-compose.yml") || has("compose.yaml");
		info.branch = gitBranch(dir);
		info.rules = RULE_FILES.filter(has);
	} catch {
		// Carpeta ilegible: sin datos.
	}
	cache.set(dir, { at: Date.now(), info });
	return info;
}

/**
 * Una línea con lo que se sabe de la carpeta, o "" si no hay nada que decir. `label`: el nombre con el
 * que la tool project ve la carpeta, para que las reglas salgan con la ruta que el modelo tiene que usar.
 */
export function formatFolderInfo(info: FolderInfo, label = ""): string {
	const parts: string[] = [];
	if (info.kind) parts.push(info.kind + (info.docker ? ", con Docker" : ""));
	else if (info.docker) parts.push("con Docker");
	if (info.commands.length) parts.push(`Comandos: ${info.commands.join(", ")}`);
	if (info.branch !== undefined) parts.push(info.branch ? `git: rama ${info.branch}` : "repositorio git");
	if (info.rules.length) parts.push(`Reglas del proyecto en ${info.rules.map((r) => (label ? `${label}/${r}` : r)).join(", ")} (léelas con project read antes de cambiar código)`);
	return parts.join(". ");
}

/** Para las pruebas. */
export function clearFolderInfoCache(): void {
	cache.clear();
}
