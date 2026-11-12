/**
 * `npm run publicar`: publica una versión nueva de Aku en GitHub para que los Aku.exe instalados la encuentren
 * (`core/update/updater.ts`). Es público: pregunta antes de subir nada.
 *
 * 1. Comprueba que `gh` (GitHub CLI) tiene sesión, que no hay cambios sin guardar ni sin subir y que la versión
 *    de package.json todavía no está publicada.
 * 2. Arma el instalador (`npm run instalador` → `dist/AkuSetup-<versión>.exe`).
 * 3. Crea la versión `v<versión>` en GitHub con el instalador; GitHub calcula su huella sha256, que el
 *    actualizador comprueba. Notas: `npm run publicar -- --notas "Qué cambió"` (si no, las arma GitHub).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { APP_DIR, APP_VERSION } from "./runtime.js";
import { UPDATE_REPO } from "./core/update/updater.js";

function fail(text: string): never {
	console.error(`\n  ✗ ${text}\n`);
	process.exit(1);
}

function run(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryRun(cmd: string, args: string[]): string | null {
	try {
		return run(cmd, args);
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const version = APP_VERSION;
	const tag = `v${version}`;
	const notesArg = process.argv.indexOf("--notas");
	const notes = notesArg >= 0 ? process.argv[notesArg + 1]?.trim() : "";
	console.log(`\n  Publicar Aku ${version} en github.com/${UPDATE_REPO}\n`);

	if (tryRun("gh", ["--version"]) === null) fail("Falta GitHub CLI (gh). Instálalo desde cli.github.com y vuelve a intentarlo.");
	if (tryRun("gh", ["auth", "status"]) === null) fail("gh no tiene sesión: ejecuta «gh auth login» y vuelve a intentarlo.");
	if (tryRun("gh", ["release", "view", tag, "--repo", UPDATE_REPO]) !== null) {
		fail(`La versión ${version} ya está publicada. Súbela en package.json (por ejemplo: npm version patch --no-git-tag-version), guarda el cambio y vuelve a intentarlo.`);
	}
	if (run("git", ["status", "--porcelain"])) fail("Hay cambios sin guardar (commit). La versión publicada tiene que ser igual al código en GitHub.");
	const head = run("git", ["rev-parse", "HEAD"]);
	const upstream = tryRun("git", ["rev-parse", "@{u}"]);
	if (upstream !== head) fail("Hay cambios sin subir a GitHub (push). Súbelos y vuelve a intentarlo.");

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question(`  Se va a armar el instalador y publicar ${tag} (público). ¿Seguir? (s/n) `)).trim().toLowerCase();
	rl.close();
	if (!["s", "si", "sí", "y", "yes"].includes(answer)) fail("No se publicó nada.");

	const build = spawnSync(process.execPath, ["--import", "tsx", join("src", "buildExe.ts"), "--instalador"], { cwd: APP_DIR, stdio: "inherit" });
	if (build.status !== 0) fail("No se pudo armar el instalador.");
	const setup = join(APP_DIR, "dist", `AkuSetup-${version}.exe`);
	if (!existsSync(setup)) fail(`No encuentro ${setup}.`);
	const sha = createHash("sha256").update(readFileSync(setup)).digest("hex");

	console.log(`\n  · Subiendo ${tag} a GitHub…`);
	const create = spawnSync(
		"gh",
		["release", "create", tag, setup, "--repo", UPDATE_REPO, "--target", head, "--title", `Aku ${version}`, ...(notes ? ["--notes", notes] : ["--generate-notes"])],
		{ cwd: APP_DIR, stdio: "inherit" },
	);
	if (create.status !== 0) fail("GitHub no aceptó la versión. Revisa el mensaje de arriba.");

	// La huella que verán los Aku instalados tiene que ser la del archivo que se armó aquí.
	const info = JSON.parse(run("gh", ["release", "view", tag, "--repo", UPDATE_REPO, "--json", "assets"])) as { assets?: { name: string; digest?: string }[] };
	const digest = info.assets?.find((a) => a.name === `AkuSetup-${version}.exe`)?.digest ?? "";
	if (digest !== `sha256:${sha}`) fail(`La huella en GitHub (${digest || "ninguna"}) no coincide con la del instalador (${sha}). Borra la versión en GitHub y vuelve a publicar.`);
	console.log(`\n  ✓ Publicada ${tag}. Los Aku.exe la verán en menos de un día, o al pulsar «Buscar actualizaciones».\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
