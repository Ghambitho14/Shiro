import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { exposedToolName, isMcpToolName, McpManager } from "./McpManager.js";
import { extractServers, parseMcpJson, splitCommandLine } from "./mcpConfig.js";
import { describeRiskyAction, canRememberApproval } from "../tools/approval.js";

test("mcp.json: acepta el formato de LM Studio / Claude y rechaza lo que está mal", () => {
	const ok = parseMcpJson(
		JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] }, docs: { url: "https://mcp.example.com/mcp" } } }),
	);
	assert.deepEqual(Object.keys(ok), ["playwright", "docs"]);
	assert.throws(() => parseMcpJson("{ esto no es json"), /JSON no es válido/);
	assert.throws(() => parseMcpJson(JSON.stringify({ mcpServers: { x: {} } })), /command.*url/);
	assert.throws(() => parseMcpJson(JSON.stringify({ mcpServers: { x: { command: "a", url: "https://b.c" } } })), /no los dos/);
	assert.throws(() => parseMcpJson(JSON.stringify({ mcpServers: { "../malo": { command: "a" } } })), /Nombre de servidor no válido/);
	assert.deepEqual(parseMcpJson(""), {});
});

test("el comando escrito en una línea se parte respetando las comillas", () => {
	assert.deepEqual(splitCommandLine("npx -y @modelcontextprotocol/server-filesystem \"C:/Mis documentos\""), [
		"npx",
		"-y",
		"@modelcontextprotocol/server-filesystem",
		"C:/Mis documentos",
	]);
	assert.deepEqual(splitCommandLine("  uvx   mcp-server-fetch "), ["uvx", "mcp-server-fetch"]);
	assert.deepEqual(splitCommandLine("cmd ''"), ["cmd", ""]);
});

test("los nombres de tools para el modelo son válidos y únicos", () => {
	assert.equal(exposedToolName("GitHub", "create_issue"), "mcp__GitHub__create_issue");
	assert.equal(exposedToolName("mi servidor", "buscar.docs"), "mcp__mi_servidor__buscar_docs");
	const long = exposedToolName("servidor-con-un-nombre-largo", "una_herramienta_con_un_nombre_larguisimo_de_verdad");
	assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long));
	assert.notEqual(long, exposedToolName("servidor-con-un-nombre-largo", "una_herramienta_con_un_nombre_larguisimo_de_verdad2"));
	assert.ok(isMcpToolName(long));
	assert.equal(isMcpToolName("pc_open"), false);
});

test("importar: entiende OpenCode y VS Code, y no importa el propio servidor de Shiro", () => {
	const fromOpencode = extractServers("opencode", {
		mcp: {
			shiro: { type: "local", command: ["node", "C:/x/Shiro/bin/shiro-mcp.mjs"] },
			fs: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/tmp"], enabled: false },
			docs: { type: "remote", url: "https://mcp.context7.com/mcp" },
		},
	});
	assert.deepEqual(Object.keys(fromOpencode).sort(), ["docs", "fs"]);
	assert.equal(fromOpencode.fs.command, "npx");
	assert.deepEqual(fromOpencode.fs.args, ["-y", "@modelcontextprotocol/server-filesystem", "C:/tmp"]);
	assert.equal(fromOpencode.fs.disabled, true);

	const fromVsCode = extractServers("vscode", { servers: { gh: { type: "stdio", command: "docker", args: ["run"] }, raro: { foo: 1 } } });
	assert.deepEqual(Object.keys(fromVsCode), ["gh"]);
	assert.equal(fromVsCode.gh.type, undefined);
});

test("las tools MCP piden permiso (y se pueden permitir para todo el chat)", () => {
	const summary = describeRiskyAction("mcp__gmail__send_email", { to: "a@b.c", body: "hola" });
	assert.ok(summary?.includes("send_email") || summary?.includes("mcp__gmail__send_email"));
	assert.ok(summary?.includes("to: a@b.c"));
	assert.equal(canRememberApproval("mcp__gmail__send_email"), true);
	assert.equal(canRememberApproval("exec"), false);
});

test("McpManager se conecta a un servidor por stdio, lista sus tools y las ejecuta", async () => {
	const fixture = fileURLToPath(new URL("./echoServer.fixture.mjs", import.meta.url));
	const mgr = new McpManager(() => ({
		servers: { eco: { command: process.execPath, args: [fixture], disabledTools: ["falla-no-existe"] } },
	}));
	try {
		await mgr.reload();
		await mgr.whenReady(30_000);
		const [st] = mgr.status();
		assert.equal(st.state, "ready", st.error);
		assert.deepEqual(
			st.tools.map((t) => t.name),
			["echo", "falla"],
		);
		assert.equal(st.tools[0].readOnly, true);
		assert.ok(st.log.some((l) => l.includes("eco listo")));

		const defs = mgr.getToolDefs();
		assert.equal(defs[0].function.name, "mcp__eco__echo");
		assert.equal((defs[0].function.parameters as Record<string, unknown>).$schema, undefined);

		assert.deepEqual(await mgr.callTool("mcp__eco__echo", { text: "hola" }), { ok: true, content: "hola" });
		const bad = await mgr.callTool("mcp__eco__falla", {});
		assert.equal(bad.ok, false);
		assert.equal(!bad.ok && bad.error, "algo salió mal");
		assert.equal((await mgr.callTool("mcp__eco__nada", {})).ok, false);

		// Reiniciar (también a mitad de arranque) lo deja conectado otra vez.
		await mgr.restart("eco");
		await mgr.restart("eco");
		await mgr.whenReady(30_000);
		assert.equal(mgr.status()[0].state, "ready");
		assert.deepEqual(await mgr.callTool("mcp__eco__echo", { text: "otra vez" }), { ok: true, content: "otra vez" });
	} finally {
		await mgr.closeAll();
	}
});

test("McpManager explica el error si el programa no existe", async () => {
	const mgr = new McpManager(() => ({ servers: { roto: { command: "programa-que-no-existe-shiro" } } }));
	try {
		await mgr.reload();
		await mgr.whenReady(30_000);
		const [st] = mgr.status();
		assert.equal(st.state, "error");
		assert.match(st.error ?? "", /No encontré el programa/);
		assert.deepEqual(mgr.getToolNames(), []);
	} finally {
		await mgr.closeAll();
	}
});
