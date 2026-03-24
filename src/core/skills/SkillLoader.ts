import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../../config/config.js";
import { WORKSPACE_DIR } from "../../workspace.js";

type SkillDoc = {
	name: string;
	path: string;
	content: string;
	score: number;
};

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9áéíóúñü]+/i)
		.map((t) => t.trim())
		.filter((t) => t.length >= 3);
}

function scoreSkill(goalTokens: Set<string>, content: string, path: string): number {
	if (goalTokens.size === 0) return 1;
	const source = `${path}\n${content}`.toLowerCase();
	let score = 0;
	for (const token of goalTokens) {
		if (!source.includes(token)) continue;
		score += token.length >= 7 ? 3 : 2;
	}
	return score;
}

function collectSkillFilesFromRoot(rootPath: string): string[] {
	if (!existsSync(rootPath)) return [];
	const root = resolve(rootPath);
	try {
		const stats = statSync(root);
		if (!stats.isDirectory()) return [];
	} catch {
		return [];
	}
	const entries = readdirSync(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillFile = join(root, entry.name, "SKILL.md");
		if (existsSync(skillFile)) files.push(skillFile);
	}
	return files;
}

export function loadRelevantSkills(goal: string, maxChars?: number): string {
	const cfg = getConfig();
	const budget = typeof maxChars === "number" && maxChars > 0
		? maxChars
		: (cfg.skillsMaxChars ?? 3000);

	const roots = [
		join(WORKSPACE_DIR, "skills"),
		...(cfg.skillPaths ?? []).map((p) => resolve(p)),
	];
	const filePaths = Array.from(new Set(roots.flatMap((root) => collectSkillFilesFromRoot(root))));
	if (filePaths.length === 0) return "";

	const goalTokens = new Set(tokenize(goal).slice(0, 30));
	const docs: SkillDoc[] = [];
	for (const path of filePaths) {
		try {
			const content = readFileSync(path, "utf-8").trim();
			if (!content) continue;
			const score = scoreSkill(goalTokens, content, path);
			if (score <= 0) continue;
			docs.push({
				name: path.split(/[\\/]/).slice(-2, -1)[0] ?? "skill",
				path,
				content,
				score,
			});
		} catch {
			continue;
		}
	}
	if (docs.length === 0) return "";

	docs.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.name.localeCompare(b.name);
	});

	let remaining = budget;
	const blocks: string[] = [];
	for (const doc of docs) {
		if (remaining <= 120) break;
		const header = `### ${doc.name}\nPath: ${doc.path}\n`;
		const allowed = Math.max(0, remaining - header.length - 2);
		if (allowed <= 0) break;
		const clipped = doc.content.length > allowed
			? doc.content.slice(0, allowed) + "\n..."
			: doc.content;
		blocks.push(`${header}${clipped}`);
		remaining -= (header.length + clipped.length + 2);
	}
	if (blocks.length === 0) return "";
	return `## Skills relevantes\n${blocks.join("\n\n")}`;
}
