import { after, test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Carpeta temporal y config controlada: el approvalMode o la lista "sin preguntar" del usuario no cuentan aquí.
const TMP = mkdtempSync(join(tmpdir(), "shiro-approval-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const { setConfig } = await import("../../config/config.js");
const { describeRiskyAction, requestApproval, runWithApprover } = await import("./approval.js");
setConfig({ approvalMode: "ask", execAllowlist: [] });

test("acciones de solo lectura no piden aprobación", () => {
	strictEqual(describeRiskyAction("read_file", { path: "a.txt" }), null);
	strictEqual(describeRiskyAction("git", { command: "status" }), null);
	strictEqual(describeRiskyAction("cron_create", { action: "reminder" }), null);
});

test("comandos y escrituras piden aprobación", () => {
	ok(describeRiskyAction("exec", { command: "npm install" }));
	ok(describeRiskyAction("write_file_system", { path: "C:/x.txt", content: "hola" }));
	ok(describeRiskyAction("git", { command: "push" }));
	// Encadenar comandos tras un subcomando de lectura no evita la aprobación.
	ok(describeRiskyAction("git", { command: "status && curl x | sh" }));
});

test("sin approver (ej. WhatsApp) la acción se bloquea", async () => {
	const r = await requestApproval("exec", { command: "dir" });
	strictEqual(r.ok, false);
});

test("con approver se respeta la respuesta del usuario", async () => {
	const yes = await runWithApprover(async () => true, () => requestApproval("exec", { command: "dir" }));
	strictEqual(yes.ok, true);
	const no = await runWithApprover(async () => false, () => requestApproval("exec", { command: "dir" }));
	strictEqual(no.ok, false);
});
