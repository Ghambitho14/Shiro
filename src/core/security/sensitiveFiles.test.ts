import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isSensitiveFile, mentionsSensitiveFile } from "./sensitiveFiles.js";

const SENSITIVE = [
	".env",
	".env.local",
	"app/.env.production",
	"C:\\Users\\yo\\proyecto\\.env",
	"/home/kali/.ssh/id_rsa",
	"~/.ssh/config",
	"id_ed25519",
	".npmrc",
	".netrc",
	".pgpass",
	".git-credentials",
	"/home/yo/.aws/credentials",
	"gcloud/credentials.json",
	"secrets.yaml",
	"config/secret.json",
	"service-account-prod.json",
	"certs/server.pem",
	"tls.key",
	"firma.p12",
	"Contraseñas.kdbx",
	"release.keystore",
	"putty.ppk",
	'"mi carpeta/.env"',
];
const NORMAL = [
	".env.example",
	"app/.env.sample",
	".env.template",
	"README.md",
	"src/secrets.ts",
	"src/credentials.ts",
	"docs/env.md",
	"package.json",
	"id_rsa.pub",
	"keys.txt",
	"monkey.js",
	"",
];

test("isSensitiveFile reconoce los archivos con claves", () => {
	for (const p of SENSITIVE) assert.equal(isSensitiveFile(p), true, p);
});

test("isSensitiveFile deja pasar lo normal y las plantillas de ejemplo", () => {
	for (const p of NORMAL) assert.equal(isSensitiveFile(p), false, p);
});

test("mentionsSensitiveFile mira cada palabra del comando", () => {
	for (const c of ["cat .env", "type secrets.json", "Get-Content .\\.env", "git diff -- .env", "git show HEAD:.env", "head -5 certs/server.pem | wc -l", "cat ~/.ssh/id_rsa"]) {
		assert.equal(mentionsSensitiveFile(c), true, c);
	}
	for (const c of ["cat README.md", "ls -la", "cat .env.example", "npm run env", "grep -r TOKEN src"]) assert.equal(mentionsSensitiveFile(c), false, c);
});

test("la copia de la web (public/js/sensitiveFiles.js) dice lo mismo", async () => {
	const web = (await import(pathToFileURL(join(process.cwd(), "public", "js", "sensitiveFiles.js")).href)) as { isSensitiveFile: (p: string) => boolean };
	for (const p of [...SENSITIVE, ...NORMAL]) assert.equal(web.isSensitiveFile(p), isSensitiveFile(p), p);
});

const TMP = mkdtempSync(join(tmpdir(), "shiro-sensitive-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

test("el proyecto no busca dentro de los archivos con claves ni los pone en las instrucciones", async () => {
	const { addFolder, createProject, inlineProjectText, searchProject } = await import("../projects/projects.js");
	const dir = join(TMP, "app");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "notas.md"), "La clave del servidor está en otro lado");
	writeFileSync(join(dir, "credentials.json"), '{"clave": "Gato1234"}');
	const p = addFolder(createProject({ name: "App" }).id, dir)!;
	const found = await searchProject(p, "clave");
	assert.ok(found.results.some((r) => r.includes("notas.md")));
	assert.ok(!found.results.some((r) => r.includes("credentials.json")), found.results.join("\n"));
	const inline = (await inlineProjectText(p)) ?? "";
	assert.match(inline, /notas\.md/);
	assert.doesNotMatch(inline, /Gato1234/);
});
