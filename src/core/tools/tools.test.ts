import { test } from "node:test";
import { strictEqual } from "node:assert";
import { executeTool, getWorkspaceDir } from "./tools.js";

test("executeTool read_file rechaza path fuera del workspace (traversal)", async () => {
	const r = await executeTool("read_file", { path: ".." });
	strictEqual(r.ok, false);
	strictEqual((r as { error: string }).error, "Path fuera del workspace.");
});

test("executeTool read_file rechaza path con barra fuera del workspace", async () => {
	const r = await executeTool("read_file", { path: "../other" });
	strictEqual(r.ok, false);
	strictEqual((r as { error: string }).error, "Path fuera del workspace.");
});

test("executeTool write_file rechaza path fuera del workspace", async () => {
	const r = await executeTool("write_file", { path: "..", content: "x" });
	strictEqual(r.ok, false);
	strictEqual((r as { error: string }).error, "Path fuera del workspace.");
});

test("executeTool list_dir rechaza path fuera del workspace", async () => {
	const r = await executeTool("list_dir", { path: "../" });
	strictEqual(r.ok, false);
	strictEqual((r as { error: string }).error, "Directorio no encontrado.");
});

test("executeTool read_file_system rechaza path fuera del ámbito", async () => {
	const r = await executeTool("read_file_system", { path: "../" });
	strictEqual(r.ok, false);
	const err = (r as { error: string }).error;
	strictEqual(err.includes("fuera del ámbito permitido"), true);
});

test("executeTool write_file_system rechaza path fuera del ámbito", async () => {
	const r = await executeTool("write_file_system", { path: "../../../etc/out", content: "x" });
	strictEqual(r.ok, false);
	strictEqual((r as { error: string }).error, "Path fuera del ámbito permitido.");
});

test("getWorkspaceDir devuelve ruta bajo data", () => {
	const dir = getWorkspaceDir();
	strictEqual(dir.includes("workspace"), true);
	strictEqual(dir.includes("data"), true);
});
