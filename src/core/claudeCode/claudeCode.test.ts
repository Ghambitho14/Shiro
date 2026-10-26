import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal, y un «claude» falso que imita la salida stream-json de Claude Code.
const TMP = mkdtempSync(join(tmpdir(), "shiro-claude-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const FAKE = join(TMP, "bin", "claude.cjs");
const LOG = join(TMP, "llamada.json");
mkdirSync(join(TMP, "bin"), { recursive: true });
writeFileSync(
	FAKE,
	`const fs = require("fs");
fs.writeFileSync(${JSON.stringify(LOG)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), apiKey: process.env.ANTHROPIC_API_KEY ?? null }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "s1" });
if (process.env.FAKE_CLAUDE === "slow") {
	setTimeout(() => {}, 30000);
	return;
}
if (process.env.FAKE_CLAUDE === "login") {
	out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" });
	process.exit(1);
}
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/app.ts" } }] } });
out({ type: "assistant", message: { content: [{ type: "text", text: "Arreglé el error en src/app.ts." }] } });
out({ type: "result", subtype: "success", is_error: false, result: "Listo: cambié src/app.ts y las pruebas pasan.", num_turns: 3, total_cost_usd: 0.01, session_id: "s1" });
`,
);
process.env.SHIRO_CLAUDE_PATH = FAKE;

const cc = await import("./claudeCode.js");
const projects = await import("../projects/projects.js");
const { executeTool } = await import("../tools/tools.js");
const { describeRiskyAction, canRememberApproval } = await import("../tools/approval.js");
const { terminal } = await import("../terminal/terminal.js");

const text = (r: { ok: true; content: string } | { ok: false; error: string }) => (r.ok ? r.content : r.error);

test("lee la salida stream-json de Claude Code", () => {
	assert.deepEqual(cc.parseClaudeLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm   test" } }, { type: "text", text: " Hecho " }] } })), [
		{ kind: "tool", name: "Bash", detail: "npm test" },
		{ kind: "text", text: "Hecho" },
	]);
	assert.deepEqual(cc.parseClaudeLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", num_turns: 2 })), [
		{ kind: "result", ok: true, text: "ok", costUsd: undefined, turns: 2, sessionId: undefined },
	]);
	assert.deepEqual(cc.parseClaudeLine("esto no es json"), []);
	assert.deepEqual(cc.parseClaudeLine(JSON.stringify({ type: "system", subtype: "init" })), []);
});

test("argumentos: sin ventana, puede editar, y una tarea que empieza por «-» no se toma por opción", () => {
	assert.deepEqual(cc.buildClaudeArgs("arregla el login"), ["-p", "arregla el login", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
	assert.equal(cc.buildClaudeArgs("--dangerously-skip-permissions")[1], "Tarea: --dangerously-skip-permissions");
	assert.ok(cc.buildClaudeArgs("sigue", { continue: true }).includes("--continue"));
});

test("errores en español: sin sesión iniciada y límite del plan", () => {
	assert.match(cc.explainClaudeError("Invalid API key · Please run /login"), /\/login/);
	assert.match(cc.explainClaudeError("Claude usage limit reached"), /límite de uso/);
	assert.match(cc.explainClaudeError("otra cosa"), /^Claude Code falló: otra cosa/);
});

test("encuentra claude en el PATH, y en Windows el de npm con node + cli.js", () => {
	const bin = join(TMP, "bin-linux");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "claude"), "");
	assert.equal(cc.findClaudeCode({ PATH: bin, HOME: TMP }, "linux")?.file, join(bin, "claude"));
	assert.deepEqual(cc.findClaudeCode({ SHIRO_CLAUDE_PATH: FAKE, PATH: "", HOME: TMP }, "linux"), { file: "node", prefix: [FAKE], label: FAKE });
	assert.equal(cc.findClaudeCode({ PATH: join(TMP, "nada"), HOME: TMP }, "linux"), null);
	const npm = join(TMP, "npm");
	mkdirSync(npm, { recursive: true });
	writeFileSync(join(npm, "claude.cmd"), "@echo off\n");
	assert.equal(cc.findClaudeCode({ PATH: npm, HOME: TMP }, "win32"), null, "sin cli.js no se puede lanzar un .cmd");
	const cli = join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
	mkdirSync(join(cli, ".."), { recursive: true });
	writeFileSync(cli, "");
	assert.deepEqual(cc.findClaudeCode({ PATH: npm, HOME: TMP }, "win32"), { file: "node", prefix: [cli], label: join(npm, "claude.cmd") });
});

test("claude_code pide permiso siempre (y no se puede «permitir siempre»)", () => {
	assert.match(describeRiskyAction("claude_code", { task: "arregla el login", folder: "MiApp" }) ?? "", /Claude Code.*MiApp.*arregla el login/);
	assert.equal(canRememberApproval("claude_code"), false);
});

test("claude_code solo trabaja en una carpeta del proyecto", async () => {
	assert.match(text(await executeTool("claude_code", { task: "hola" })), /solo trabaja en un proyecto/);
	const p = projects.createProject({ name: "Tienda" });
	assert.match(text(await projects.runWithProject(p, () => executeTool("claude_code", { task: "hola" }))), /no tiene carpetas vinculadas/);
	for (const name of ["MiApp", "Otra"]) mkdirSync(join(TMP, name), { recursive: true });
	projects.addFolder(p.id, join(TMP, "MiApp"));
	projects.addFolder(p.id, join(TMP, "Otra"));
	const two = projects.getProject(p.id)!;
	assert.match(text(await projects.runWithProject(two, () => executeTool("claude_code", { task: "hola" }))), /Indica la carpeta.*MiApp.*Otra/);
	assert.match(text(await projects.runWithProject(two, () => executeTool("claude_code", { task: "hola", folder: "../.." }))), /no es una carpeta vinculada/);
});

test("claude_code ejecuta Claude Code en la carpeta, sin claves, y enseña el progreso en la terminal", async () => {
	const p = projects.createProject({ name: "App" });
	const folder = join(TMP, "App");
	mkdirSync(folder, { recursive: true });
	projects.addFolder(p.id, folder);
	const seen: string[] = [];
	const stop = terminal.subscribe((e) => {
		if (e.type === "block") seen.push(e.block.command);
		if (e.type === "out") seen.push(e.text);
	});
	process.env.ANTHROPIC_API_KEY = "sk-ant-no-se-pasa";
	try {
		const r = await projects.runWithProject(projects.getProject(p.id)!, () => executeTool("claude_code", { task: "arregla el login", continue: true }));
		assert.equal(r.ok, true, text(r));
		assert.match(text(r), /Claude Code terminó en App · 3 pasos[\s\S]*Listo: cambié src\/app\.ts/);
		const call = JSON.parse(readFileSync(LOG, "utf-8")) as { argv: string[]; cwd: string; apiKey: string | null };
		assert.deepEqual(call.argv, [...cc.buildClaudeArgs("arregla el login", { continue: true })]);
		assert.equal(call.cwd, folder);
		assert.equal(call.apiKey, null, "usa la suscripción, no la API");
		assert.ok(seen.some((s) => s.startsWith("Claude Code (sigue): arregla el login")));
		assert.ok(seen.some((s) => s.includes("▸ Edit: src/app.ts")));
		// Sin sesión iniciada: el error dice qué hacer.
		process.env.FAKE_CLAUDE = "login";
		const bad = await projects.runWithProject(projects.getProject(p.id)!, () => executeTool("claude_code", { task: "otra" }));
		assert.equal(bad.ok, false);
		assert.match(text(bad), /\/login/);
		// El botón de parar del panel Terminal lo detiene.
		process.env.FAKE_CLAUDE = "slow";
		const running = projects.runWithProject(projects.getProject(p.id)!, () => executeTool("claude_code", { task: "algo largo" }));
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(terminal.stop(), true);
		const stopped = await running;
		assert.equal(stopped.ok, false);
		assert.match(text(stopped), /Detuviste a Claude Code/);
	} finally {
		stop();
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.FAKE_CLAUDE;
	}
});
