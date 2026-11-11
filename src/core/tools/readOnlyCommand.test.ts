import { after, test } from "node:test";
import { strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "shiro-readonly-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { isReadOnlyCommand, isFreeReadCommand } = await import("./readOnlyCommand.js");
const { createProject, addFolder, runWithProject } = await import("../projects/projects.js");
const { describeRiskyAction, runWithApprover, noteExternalRead } = await import("./approval.js");

test("comandos que solo miran: pasan los de la lista, también con tuberías entre ellos", () => {
	for (const ok of ["ls", "ls -la src", "dir", "cat package.json", "type README.md", "git status", "git log -5 --oneline", "grep -rn todo src | head -20", "Get-ChildItem src", "node --version", "rg paintTodo public", "find . -name *.ts", "cd src"]) {
		strictEqual(isReadOnlyCommand(ok), true, ok);
	}
});

test("comandos que solo miran: lo que escribe, encadena, ejecuta o sale de la carpeta no pasa", () => {
	const no = [
		"", "rm x", "npm test", "npm install", "node script.js", "ls; rm x", "ls && rm x", "cat a > b", "echo hola > x", "cat $(pwd)", "cat `x`",
		"cat C:\\Users\\x\\secreto.txt", "cat /etc/passwd", "cat ../otro/.env", "cat ~/.ssh/id_rsa", "type %USERPROFILE%\\x", "dir \\\\servidor\\c",
		"find . -delete", "find . -exec rm {} +", "rg --pre cat x", "sort -o salida a", "git push", "git branch -D main", "git diff --output=x", "git -C .. status",
		"ls | xargs rm", "cat x | sh", "curl http://x",
	];
	for (const bad of no) strictEqual(isReadOnlyCommand(bad), false, bad);
});

test("sin permiso solo dentro de una carpeta del proyecto del chat y sin haber leído nada de afuera", async () => {
	const folder = join(TMP, "mi-app");
	mkdirSync(join(folder, "src"), { recursive: true });
	const project = addFolder(createProject({ name: "mi-app" }).id, folder)!;
	// Sin proyecto se pregunta siempre.
	strictEqual(isFreeReadCommand("ls", folder), false);
	strictEqual(describeRiskyAction("exec", { command: "ls", workingDir: folder }) !== null, true);

	await runWithProject(project, async () => {
		strictEqual(isFreeReadCommand("ls", join(folder, "src")), true);
		strictEqual(isFreeReadCommand("ls", TMP), false);
		strictEqual(isFreeReadCommand("ls", undefined), false);
		// Entrar a la carpeta del proyecto desde fuera no pregunta; a otra carpeta, o con algo más detrás, sí.
		strictEqual(isFreeReadCommand(`cd "${folder}"`, TMP), true);
		strictEqual(isFreeReadCommand(`cd ${join(folder, "src")}`, undefined), true);
		strictEqual(isFreeReadCommand(`cd ${TMP}`, folder), false);
		strictEqual(isFreeReadCommand(`cd ${folder}; rm x`, TMP), false);
		strictEqual(isFreeReadCommand("cd ..", join(folder, "src")), true);
		strictEqual(isFreeReadCommand("cd ..", folder), false);
		// Encadenar vale si cada parte solo mira y corre dentro del proyecto.
		strictEqual(isFreeReadCommand(`cd "${folder}" && ls -la`, TMP), true);
		strictEqual(isFreeReadCommand(`cd ${folder}; cd src; cat a.js | head -5`, TMP), true);
		strictEqual(isFreeReadCommand("ls && git status", folder), true);
		strictEqual(isFreeReadCommand(`cd ${folder} && npm test`, TMP), false);
		strictEqual(isFreeReadCommand(`cd ${folder} && cd .. && ls`, TMP), false);
		strictEqual(isFreeReadCommand("cd mi-app && ls", join(TMP, "otra")), false);
		strictEqual(isFreeReadCommand("ls & rm x", folder), false);
		strictEqual(isFreeReadCommand("ls || rm x", folder), false);
		strictEqual(describeRiskyAction("exec", { command: "git status", workingDir: folder }), null);
		strictEqual(describeRiskyAction("exec", { command: "npm test", workingDir: folder }) !== null, true);
		// exec sin carpeta corre donde está Aku, no en el proyecto: pregunta.
		strictEqual(describeRiskyAction("exec", { command: "ls" }) !== null, true);
		// Tras leer una web vuelve a preguntar: la página podría pedir que lea y mande archivos.
		await runWithApprover(async () => true, async () => {
			strictEqual(describeRiskyAction("exec", { command: "cat .env", workingDir: folder }), null);
			noteExternalRead();
			strictEqual(describeRiskyAction("exec", { command: "cat .env", workingDir: folder }) !== null, true);
		});
	});
});
