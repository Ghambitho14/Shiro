/**
 * Se carga antes de cada archivo de prueba (`npm test`): si la prueba no eligió su propia carpeta,
 * usa una temporal. Así ninguna prueba lee ni escribe el data/ real (config.json, chats, notas…).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.SHIRO_DATA_DIR) {
	const dir = mkdtempSync(join(tmpdir(), "shiro-test-"));
	process.env.SHIRO_DATA_DIR = join(dir, "data");
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}
