import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFolderInfoCache, describeFolder, formatFolderInfo } from "./folderInfo.js";

const TMP = mkdtempSync(join(tmpdir(), "shiro-folder-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function folder(name: string, files: Record<string, string>): string {
	const dir = join(TMP, name);
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("un proyecto de Node: gestor de paquetes, comandos para comprobar, rama y reglas", () => {
	const dir = folder("node", {
		"package.json": JSON.stringify({ scripts: { dev: "tsx watch", check: "tsc --noEmit", test: "node --test", deploy: "x", build: "x" } }),
		"tsconfig.json": "{}",
		"pnpm-lock.yaml": "",
		".git/HEAD": "ref: refs/heads/feature/login\n",
		"AGENTS.md": "# reglas",
		"README.md": "# hola",
	});
	const info = describeFolder(dir);
	assert.equal(info.kind, "Node/TypeScript (pnpm)");
	// En orden de utilidad, sin los que no sirven para comprobar (deploy).
	assert.deepEqual(info.commands, ["pnpm run check", "pnpm test", "pnpm run build", "pnpm run dev"]);
	assert.equal(info.branch, "feature/login");
	assert.deepEqual(info.rules, ["AGENTS.md", "README.md"]);
	assert.equal(
		formatFolderInfo(info),
		"Node/TypeScript (pnpm). Comandos: pnpm run check, pnpm test, pnpm run build, pnpm run dev. git: rama feature/login. Reglas del proyecto en AGENTS.md, README.md (léelas con project read antes de cambiar código)",
	);
	// Con el nombre que la tool project le da a la carpeta, las reglas salen con su ruta.
	assert.match(formatFolderInfo(info, "MiApp"), /Reglas del proyecto en MiApp\/AGENTS\.md, MiApp\/README\.md/);
});

test("otros tipos de proyecto, package.json roto y carpetas sin nada", () => {
	assert.equal(formatFolderInfo(describeFolder(folder("rust", { "Cargo.toml": "", Dockerfile: "" }))), "Rust, con Docker. Comandos: cargo check, cargo test");
	assert.equal(describeFolder(folder("py", { "pyproject.toml": "[tool.pytest.ini_options]" })).commands[0], "pytest");
	const broken = describeFolder(folder("roto", { "package.json": "{ no es json" }));
	assert.equal(broken.kind, "Node (npm)");
	assert.deepEqual(broken.commands, []);
	// Un worktree: .git es un archivo. Es un repositorio, pero no se sabe la rama.
	assert.equal(formatFolderInfo(describeFolder(folder("worktree", { ".git": "gitdir: ../x" }))), "repositorio git");
	assert.equal(formatFolderInfo(describeFolder(folder("vacia", {}))), "");
	assert.equal(formatFolderInfo(describeFolder(join(TMP, "no-existe"))), "");
});

test("se vuelve a mirar al limpiar la caché", () => {
	const dir = folder("cambia", { "go.mod": "" });
	assert.equal(describeFolder(dir).branch, undefined);
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
	assert.equal(describeFolder(dir).branch, undefined);
	clearFolderInfoCache();
	assert.equal(describeFolder(dir).branch, "main");
});
