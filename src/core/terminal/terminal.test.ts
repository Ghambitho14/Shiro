import { after, test } from "node:test";
import { ok, strictEqual, throws } from "node:assert";
import { cleanEnv, looksLikePasswordPrompt, parseKeys, stripAnsi, terminal, TerminalSession, wrapCommand, type TermEvent } from "./terminal.js";
import { describeRiskyAction } from "../tools/approval.js";

const WIN = process.platform === "win32";
const opened: TerminalSession[] = [];
const session = () => {
	const t = new TerminalSession();
	opened.push(t);
	return t;
};
after(() => {
	for (const t of opened) t.dispose();
	// Los hilos internos de la consola no dejarían terminar al proceso de pruebas.
	setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("stripAnsi quita colores y códigos de cursor", () => {
	strictEqual(stripAnsi("\x1b[31mrojo\x1b[0m normal \x1b]0;titulo\x07fin"), "rojo normal fin");
});

test("cleanEnv quita claves y lo que confundiría a Claude Code", () => {
	process.env.ALGO_API_KEY = "x";
	process.env.CLAUDECODE = "1";
	const env = cleanEnv();
	delete process.env.ALGO_API_KEY;
	delete process.env.CLAUDECODE;
	strictEqual(env.ALGO_API_KEY, undefined);
	strictEqual(env.CLAUDECODE, undefined);
});

test("parseKeys traduce teclas y rechaza las desconocidas", () => {
	strictEqual(parseKeys("ctrl+c"), "\x03");
	strictEqual(parseKeys("down down enter"), "\x1b[B\x1b[B\r");
	strictEqual(parseKeys("Esc, y"), "\x1by");
	strictEqual(parseKeys(""), "");
	throws(() => parseKeys("hyper+x"), /No conozco la tecla/);
});

test("reconoce cuándo un programa pide contraseña", () => {
	for (const line of ["[sudo] password for kali: ", "Password for 'https://x@github.com':", "Enter passphrase for key '/home/k/.ssh/id':", "Contraseña:", "Clave secreta: ", "Enter PIN:"]) {
		ok(looksLikePasswordPrompt(line), line);
	}
	for (const line of ["PS C:\\Users> ", "password actualizada correctamente", "¿Continuar? [s/n]", "Compilando…", ""]) {
		ok(!looksLikePasswordPrompt(line), line);
	}
});

test("un comando de varias líneas se manda en una sola", () => {
	ok(!wrapCommand("pwsh", "echo a\necho b").includes("\n"));
	ok(!wrapCommand("bash", "echo a\necho b").includes("\n"));
});

test("la terminal ejecuta, conserva la carpeta y reporta el código de salida", async () => {
	const t = session();
	const hello = await t.runAndWait("echo 'hola ñandú'", { timeoutMs: 40_000 });
	strictEqual(hello.outcome, "finished");
	strictEqual(hello.exitCode, 0);
	strictEqual(hello.output.trim(), "hola ñandú");

	const fail = await t.runAndWait(WIN ? "cmd /c exit 3" : "sh -c 'exit 3'", { timeoutMs: 30_000 });
	strictEqual(fail.exitCode, 3);

	const before = t.cwd;
	const up = await t.runAndWait("cd ..", { timeoutMs: 30_000 });
	strictEqual(up.outcome, "finished");
	ok(t.cwd.length < before.length, `cd .. debería subir de carpeta (${before} → ${t.cwd})`);

	const multi = await t.runAndWait("echo primera\necho segunda", { timeoutMs: 30_000 });
	strictEqual(multi.outcome, "finished");
	ok(multi.output.includes("primera") && multi.output.includes("segunda"), multi.output);

	const text = await t.readText();
	ok(text.includes("hola ñandú"));
	ok(text.includes("lista para otro comando"));
});

test("un programa que pregunta devuelve el control y se le puede responder", { skip: !WIN }, async () => {
	const t = session();
	const asked = await t.runAndWait("$r = Read-Host 'Como te llamas'; echo \"hola $r\"", { timeoutMs: 30_000 });
	strictEqual(asked.outcome, "input");
	ok(asked.output.includes("Como te llamas"), asked.output);
	ok(t.isRunning());
	// Con un programa abierto no se escribe otro comando encima.
	let refused = "";
	await t.runAndWait("echo no", { timeoutMs: 5000 }).catch((err: Error) => (refused = err.message));
	ok(refused.includes("programa abierto"), refused);

	strictEqual(await t.write({ text: "Jhon", enter: true, timeoutMs: 15_000 }), "finished");
	ok(!t.isRunning());
	ok(t.tail().includes("hola Jhon"), t.tail());
});

test("una contraseña: sin panel avisa enseguida; con panel espera y no llega a la pantalla", { skip: !WIN }, async () => {
	const t = session();
	const alone = await t.runAndWait("$p = Read-Host -AsSecureString 'Clave secreta'; echo fin", { timeoutMs: 30_000 });
	strictEqual(alone.outcome, "password");
	ok(t.waitingForPassword());
	ok((await t.readText()).includes("pidiendo una contraseña"));
	await t.write({ keys: "ctrl+c", timeoutMs: 5000 });

	const events: TermEvent[] = [];
	const off = t.subscribe((e) => events.push(e));
	const running = t.runAndWait("$p = Read-Host -AsSecureString 'Clave secreta'; echo fin-del-comando", { timeoutMs: 2000 });
	const started = Date.now();
	while (!events.some((e) => e.type === "attention" && e.attention) && Date.now() - started < 20_000) await sleep(100);
	ok(events.some((e) => e.type === "attention" && e.attention?.kind === "password"), "el panel debe recibir el aviso");
	// Ya pasaron los 2 s del comando: sigue esperando a que el usuario la escriba.
	await sleep(2500);
	t.input("secreto123\r");
	const done = await running;
	off();
	strictEqual(done.outcome, "finished");
	ok(done.output.includes("fin-del-comando"), done.output);
	ok(!(await t.readText()).includes("secreto123"), "la contraseña no puede verse");
	ok(events.some((e) => e.type === "attention" && e.attention === null), "el aviso se quita al escribirla");
});

test("la tarjeta de permiso no enseña la contraseña que se va a teclear", { skip: !WIN }, async () => {
	const r = await terminal.runAndWait("$p = Read-Host -AsSecureString 'Password'", { timeoutMs: 30_000 });
	strictEqual(r.outcome, "password");
	const summary = describeRiskyAction("terminal", { action: "write", text: "secreto123" }) ?? "";
	ok(summary.includes("una contraseña (oculta)"), summary);
	ok(!summary.includes("secreto123"), summary);
	terminal.dispose();
});

test("stop interrumpe con Ctrl+C sin cerrar la terminal", async () => {
	const t = session();
	await t.runAndWait("cd ..", { timeoutMs: 30_000 });
	const cwd = t.cwd;
	const running = t.runAndWait(WIN ? "Start-Sleep 60" : "sleep 60", { timeoutMs: 20_000 });
	await sleep(1000);
	ok(t.isRunning());
	strictEqual(t.stop(), true);
	strictEqual(await t.whenIdle(5000), true);
	await running;
	strictEqual(t.cwd, cwd);
	const again = await t.runAndWait("echo sigo", { timeoutMs: 20_000 });
	strictEqual(again.exitCode, 0);
	strictEqual(t.stop(), false);
});

test("si el programa ignora Ctrl+C, stop reinicia la terminal en la misma carpeta", { skip: !WIN }, async () => {
	const t = session();
	await t.runAndWait("cd ..", { timeoutMs: 30_000 });
	const cwd = t.cwd;
	const events: TermEvent[] = [];
	const off = t.subscribe((e) => events.push(e));
	const running = t.runAndWait("[Console]::TreatControlCAsInput = $true; Start-Sleep 60", { timeoutMs: 20_000 });
	await sleep(1500);
	ok(t.isRunning());
	strictEqual(t.stop(), true);
	await sleep(1000);
	ok(t.isRunning(), "Ctrl+C no debería haberlo parado todavía");
	strictEqual(await t.whenIdle(5000), true);
	await running;
	off();
	ok(events.some((e) => e.type === "notice" && e.text.includes("reinicié la terminal")));
	const again = await t.runAndWait("echo otra-vez", { timeoutMs: 30_000 });
	strictEqual(again.exitCode, 0);
	strictEqual(t.cwd, cwd);
});

test("un panel que llega tarde recibe la pantalla y lo que sigue", async () => {
	const t = session();
	await t.runAndWait("echo antes-del-panel", { timeoutMs: 40_000 });
	const events: TermEvent[] = [];
	const off = t.subscribe((e) => events.push(e));
	const snapshot = events.find((e) => e.type === "snapshot");
	ok(snapshot?.type === "snapshot" && snapshot.data.includes("antes-del-panel"));
	await t.runAndWait("echo despues-del-panel", { timeoutMs: 20_000 });
	await sleep(100);
	off();
	const live = events.flatMap((e) => (e.type === "data" ? [e.data] : [])).join("");
	ok(live.includes("despues-del-panel"), live);
});

test("la terminal y el navegador piden permiso solo para acciones con efectos", () => {
	strictEqual(describeRiskyAction("terminal", { action: "read" }), null);
	strictEqual(describeRiskyAction("terminal", { action: "stop" }), null);
	ok(describeRiskyAction("terminal", { action: "run", command: "npm install" })?.includes("npm install"));
	ok(describeRiskyAction("terminal", { action: "write", text: "sí" })?.includes('"sí" y pulsar Enter'));
	ok(describeRiskyAction("terminal", { action: "write", keys: "ctrl+c" })?.includes("las teclas ctrl+c"));
	strictEqual(describeRiskyAction("browser", { action: "open", url: "youtube.com" }), null);
	strictEqual(describeRiskyAction("browser", { action: "read" }), null);
	ok(describeRiskyAction("browser", { action: "click", ref: 4 })?.includes("[4]"));
	ok(describeRiskyAction("browser", { action: "type", ref: 2, text: "hola", enter: true })?.includes("Enter"));
});
