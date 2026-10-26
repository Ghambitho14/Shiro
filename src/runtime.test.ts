import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { APP_VERSION, IS_EXE, readAppFile, resolveDataDir, SQL_WASM_FILE, VENDOR_FILES } from "./runtime.js";

const EXE_DIR = resolve("/apps/Shiro");

test("carpeta de datos: SHIRO_DATA_DIR manda, luego data/ del proyecto o junto al .exe, luego %APPDATA%", () => {
	const never = () => false;
	assert.equal(resolveDataDir({ env: { SHIRO_DATA_DIR: " /tmp/x " }, isExe: true, appDir: EXE_DIR, exists: never }), resolve("/tmp/x"));
	assert.equal(resolveDataDir({ env: {}, isExe: false, appDir: EXE_DIR, exists: never }), join(EXE_DIR, "data"));
	// .exe "portátil": si hay una carpeta data a su lado, la usa.
	const portable = join(EXE_DIR, "data");
	assert.equal(resolveDataDir({ env: { APPDATA: "C:\\AppData" }, isExe: true, appDir: EXE_DIR, exists: (p) => p === portable }), portable);
	assert.equal(resolveDataDir({ env: { APPDATA: "C:\\AppData" }, isExe: true, appDir: EXE_DIR, exists: never }), join("C:\\AppData", "Shiro"));
});

test("fuera del .exe, los archivos de la app se leen del proyecto", () => {
	assert.equal(IS_EXE, false);
	assert.match(readAppFile("public/index.html")?.toString("utf-8") ?? "", /<html/i);
	for (const rel of [...Object.values(VENDOR_FILES), SQL_WASM_FILE]) assert.ok(readAppFile(rel), `falta ${rel}`);
	assert.equal(readAppFile("public/no-existe.js"), null);
	assert.equal(readAppFile("public"), null, "una carpeta no es un archivo");
	assert.match(APP_VERSION, /^\d+\.\d+\.\d+/);
});
