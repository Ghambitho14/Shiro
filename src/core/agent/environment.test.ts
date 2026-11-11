import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildToolGuide, collectEnvironment, findOnPath, formatEnvironment, type EnvironmentFacts } from "./environment.js";

const TMP = mkdtempSync(join(tmpdir(), "shiro-env-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const WINDOWS: EnvironmentFacts = {
	os: "Windows 11 Pro (x64)",
	windows: true,
	docker: false,
	home: "C:\\Users\\yo",
	shell: { name: "PowerShell 7", kind: "pwsh", cwd: "C:\\Users\\yo\\proyecto" },
	programs: { found: ["git", "node", "npm"], missing: ["python", "rg"] },
};
const CODE_TOOLS = ["project", "terminal", "exec", "git", "search_web", "fetch_url", "browser", "memory_search", "read_file_system", "list_dir_system", "todo"];

test("Entorno: sistema, consola con su sintaxis, programas, modo y permisos", () => {
	const block = formatEnvironment(WINDOWS, { mode: "code", permissions: "ask", tools: CODE_TOOLS });
	assert.ok(block.startsWith("## Entorno\n- Sistema: Windows 11 Pro (x64). Carpeta personal: C:\\Users\\yo\n"));
	assert.match(block, /Terminal \(tool terminal\): PowerShell 7, ahora en C:\\Users\\yo\\proyecto\. Escribe comandos de PowerShell.*no de bash\. La tool exec usa cmd\.exe/);
	assert.match(block, /Programas instalados: git, node, npm\. No están: python, rg\./);
	assert.match(block, /Modo Code\. Permisos: Preguntar; leer y buscar no pide permiso/);
	assert.doesNotMatch(block, /contexto es chico/);
	assert.ok(block.length < 900, String(block.length));
});

test("Entorno: en Linux no habla de PowerShell; avisa de Docker, de poco contexto y de cada forma de permisos", () => {
	const kali: EnvironmentFacts = { ...WINDOWS, os: "Kali GNU/Linux Rolling (x64)", windows: false, docker: true, home: "/home/yo", shell: { name: "bash", kind: "bash", cwd: "/home/yo" } };
	const block = formatEnvironment(kali, { mode: "hacking", permissions: "auto", tools: CODE_TOOLS, contextLimit: 8192 });
	assert.match(block, /Kali GNU\/Linux Rolling \(x64\), dentro de un contenedor Docker/);
	assert.match(block, /Terminal \(tool terminal\): bash, ahora en \/home\/yo\.\n/);
	assert.doesNotMatch(block, /PowerShell|cmd\.exe/);
	assert.match(block, /Modo Hacking\. Permisos: Automático/);
	assert.match(block, /Tu contexto es chico \(unos 8 mil tokens\)/);
	const view = { mode: "chat" as const, tools: CODE_TOOLS };
	assert.match(formatEnvironment(kali, { ...view, permissions: "plan" }), /Planear, solo lectura/);
	assert.match(formatEnvironment(kali, { ...view, permissions: "bypass" }), /sin preguntar/);
	assert.match(formatEnvironment(kali, { ...view, permissions: "ask", approvalMode: "allow" }), /sin preguntar/);
	assert.match(formatEnvironment(kali, { ...view, permissions: "bypass", approvalMode: "deny" }), /bloqueadas en Ajustes/);
});

test("Entorno: sin terminal no cuenta la consola ni los programas", () => {
	const block = formatEnvironment(WINDOWS, { mode: "chat", permissions: "ask", tools: ["search_web", "memory_search"] });
	assert.doesNotMatch(block, /Terminal|Programas/);
	assert.match(formatEnvironment(WINDOWS, { mode: "chat", permissions: "ask", tools: ["exec"] }), /Comandos \(tool exec\): cmd\.exe/);
});

test("findOnPath: busca sin lanzar nada, con las extensiones de Windows", () => {
	const a = join(TMP, "a");
	const b = join(TMP, "b");
	mkdirSync(a);
	mkdirSync(b);
	writeFileSync(join(a, "git"), "");
	writeFileSync(join(b, "node.exe"), "x");
	writeFileSync(join(b, "npm.cmd"), "x");
	const path = [a, "", b].join(delimiter);
	assert.equal(findOnPath("git", path, false), join(a, "git"));
	assert.equal(findOnPath("node", path, false), null);
	assert.equal(findOnPath("node", path, true), join(b, "node.exe"));
	assert.equal(findOnPath("npm", path, true), join(b, "npm.cmd"));
	assert.equal(findOnPath("docker", path, true), null);
	// El python de la Microsoft Store es un acceso vacío: no cuenta.
	const store = join(TMP, "WindowsApps");
	mkdirSync(store);
	writeFileSync(join(store, "python.exe"), "");
	writeFileSync(join(store, "pwsh.exe"), "");
	assert.equal(findOnPath("python", store, true), null);
	assert.equal(findOnPath("pwsh", store, true), join(store, "pwsh.exe"));
});

test("collectEnvironment describe este equipo sin fallar", () => {
	const f = collectEnvironment({ hacking: true });
	assert.ok(f.os.length > 3 && f.home.length > 1);
	assert.equal(f.programs.found.length + f.programs.missing.length, 18);
	// node corre estas pruebas: tiene que estar.
	assert.ok(f.programs.found.includes("node"));
	assert.equal(collectEnvironment().programs.missing.includes("nmap"), false);
});

test("Guía de herramientas: solo las que tiene, y lo que le falta", () => {
	const opts = { mode: "code" as const, planning: false, pcBlock: false, pcControlOff: false };
	const code = buildToolGuide(CODE_TOOLS, opts);
	assert.ok(code.startsWith("## Qué herramienta usar\n- Proyecto: project → find"));
	for (const word of ["edit (cambiar un trozo)", "terminal (action=run)", "git (status, log y diff", "fuera del proyecto", "fetch_url lee (offset", "browser si hay que pulsar", "memory_search", "lleva la lista con todo"]) {
		assert.ok(code.includes(word), word);
	}
	assert.doesNotMatch(code, /No tienes/);
	assert.ok(code.length < 1100, String(code.length));
	// Con un proyecto delante, read_file y compañía son solo de sus notas.
	assert.match(buildToolGuide([...CODE_TOOLS, "read_file"], opts), /read_file, write_file y list_dir son solo de tus notas/);
	// Al planear no se le ofrece editar; con el bloque «Control del PC» no se repiten terminal ni navegador.
	assert.doesNotMatch(buildToolGuide(CODE_TOOLS, { ...opts, planning: true }), /edit \(/);
	assert.doesNotMatch(buildToolGuide(CODE_TOOLS, { ...opts, pcBlock: true }), /terminal \(action=run\)|browser si/);
	// En Code sin carpeta: lo dice y cómo arreglarlo.
	const noFolder = buildToolGuide(["terminal", "search_web"], opts);
	assert.match(noFolder, /No tienes: archivos de proyecto \(este chat no tiene carpeta/);
	// En Chat con el control del PC apagado.
	const off = buildToolGuide(["search_web", "fetch_url"], { mode: "chat", planning: false, pcBlock: false, pcControlOff: true });
	assert.match(off, /No tienes: terminal ni control del PC \(están apagados en Ajustes\)/);
	assert.match(off, /Archivos|Internet/);
	assert.equal(buildToolGuide(["calculator"], { mode: "chat", planning: false, pcBlock: false, pcControlOff: false }), "");
});
