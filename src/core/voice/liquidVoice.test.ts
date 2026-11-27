import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiquidArgs, findLiquidModel, isLiquidAudioFile, langCode, pickLiquidFiles } from "./liquidVoice.js";
import { scanGgufFolder } from "../llamacpp/models.js";

test("reconoce el modelo de voz de Liquid y no su proyector", () => {
	assert.equal(isLiquidAudioFile("LFM3-Audio-2B-Q8_0.gguf"), true);
	assert.equal(isLiquidAudioFile("LFM2.5-Audio-1.5B-Q4_K_M.gguf"), true);
	assert.equal(isLiquidAudioFile("mmproj-LFM3-Audio-2B-Q8_0.gguf"), false);
	assert.equal(isLiquidAudioFile("LFM3-1.7B-Q8_0.gguf"), false);
});

test("elige Q8_0 y el proyector de audio", () => {
	const pick = pickLiquidFiles([
		{ name: "LFM3-Audio-2B-Q4_K_M.gguf", size: 1_100 },
		{ name: "LFM3-Audio-2B-Q8_0.gguf", size: 1_800 },
		{ name: "mmproj-LFM3-Audio-2B-Q8_0.gguf", size: 300 },
	]);
	assert.deepEqual(pick, { model: "LFM3-Audio-2B-Q8_0.gguf", mmproj: "mmproj-LFM3-Audio-2B-Q8_0.gguf" });
	assert.equal(pickLiquidFiles([{ name: "LFM3-Audio-2B-Q8_0.gguf", size: 1 }]), null, "sin proyector no sirve");
});

test("lo encuentra en una carpeta de data/models y el chat no lo ofrece", () => {
	const root = mkdtempSync(join(tmpdir(), "liquid-"));
	const dir = join(root, "LFM3-Audio-2B");
	mkdirSync(dir);
	writeFileSync(join(dir, "LFM3-Audio-2B-Q8_0.gguf"), "GGUF");
	writeFileSync(join(dir, "mmproj-LFM3-Audio-2B-Q8_0.gguf"), "GGUF");
	const m = findLiquidModel(root);
	assert.equal(m?.name, "LFM3-Audio-2B-Q8_0");
	assert.equal(m?.mmproj, join(dir, "mmproj-LFM3-Audio-2B-Q8_0.gguf"));
	assert.equal(findLiquidModel(join(root, "no-existe")), null);
	assert.deepEqual(scanGgufFolder(root, "shiro"), []);
});

test("argumentos: solo 127.0.0.1, con proyector e idioma, sin dormir", () => {
	const args = buildLiquidArgs({ model: { path: "m.gguf", mmproj: "p.gguf", name: "m", sizeBytes: 1 }, port: 1234, lang: "es" });
	assert.deepEqual(args.slice(0, 8), ["-m", "m.gguf", "--mmproj", "p.gguf", "--host", "127.0.0.1", "--port", "1234"]);
	assert.equal(args[args.indexOf("--tts-lang") + 1], "es");
	assert.equal(args.includes("--sleep-idle-seconds"), false);
});

test("idioma de la voz", () => {
	assert.equal(langCode("es-CL"), "es");
	assert.equal(langCode("EN-us"), "en");
	assert.equal(langCode(undefined), "es");
	assert.equal(langCode("??"), "es");
});
