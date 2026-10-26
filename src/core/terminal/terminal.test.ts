import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { stripAnsi, TerminalSession } from "./terminal.js";
import { describeRiskyAction } from "../tools/approval.js";

test("stripAnsi quita colores y códigos de cursor", () => {
	strictEqual(stripAnsi("\x1b[31mrojo\x1b[0m normal \x1b]0;titulo\x07fin"), "rojo normal fin");
});

test("la terminal ejecuta, conserva la carpeta y reporta el código de salida", async () => {
	const t = new TerminalSession();
	try {
		const ok1 = await t.runAndWait(process.platform === "win32" ? "echo 'hola ñandú'" : "echo 'hola ñandú'", "user", 30_000);
		strictEqual(ok1.finished, true);
		strictEqual(ok1.block.exitCode, 0);
		strictEqual(TerminalSession.outputOf(ok1.block).trim(), "hola ñandú");

		const fail = await t.runAndWait(process.platform === "win32" ? "cmd /c exit 3" : "sh -c 'exit 3'", "shiro", 30_000);
		strictEqual(fail.block.exitCode, 3);

		const before = t.cwd;
		await t.runAndWait("cd ..", "user", 30_000);
		ok(t.cwd.length < before.length, `cd .. debería subir de carpeta (${before} → ${t.cwd})`);

		const text = t.readText();
		ok(text.includes("hola ñandú"));
		ok(text.includes("(lo ejecutó Shiro)"));
		ok(text.includes("código 3"));
	} finally {
		t.stop();
	}
});

test("la terminal y el navegador piden permiso solo para acciones con efectos", () => {
	strictEqual(describeRiskyAction("terminal", { action: "read" }), null);
	strictEqual(describeRiskyAction("terminal", { action: "stop" }), null);
	ok(describeRiskyAction("terminal", { action: "run", command: "npm install" })?.includes("npm install"));
	strictEqual(describeRiskyAction("browser", { action: "open", url: "youtube.com" }), null);
	strictEqual(describeRiskyAction("browser", { action: "read" }), null);
	ok(describeRiskyAction("browser", { action: "click", ref: 4 })?.includes("[4]"));
	ok(describeRiskyAction("browser", { action: "type", ref: 2, text: "hola", enter: true })?.includes("Enter"));
});
