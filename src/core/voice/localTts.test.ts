import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_VOICES, VOICE_PACKS, listLocalVoices, speakLocal, toWav } from "./localTts.js";
import { sherpaPlatformPackage } from "./sherpaLoader.js";

test("WAV de 16 bits", () => {
	const wav = toWav(new Float32Array([0, 1, -1, 2]), 22050);
	assert.equal(wav.length, 44 + 8);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	assert.equal(wav.readUInt32LE(24), 22050);
	assert.equal(wav.readUInt32LE(40), 8);
	assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48), wav.readInt16LE(50)], [0, 32767, -32768, 32767], "lo que pasa de 1 se recorta");
});

test("catálogo de voces sin internet", () => {
	const packs = new Set(VOICE_PACKS.map((p) => p.id));
	for (const v of LOCAL_VOICES) assert.ok(packs.has(v.pack), `${v.id} apunta a un paquete que existe`);
	for (const p of VOICE_PACKS) assert.match(p.sha256, /^[0-9a-f]{64}$/);
	assert.equal(new Set(LOCAL_VOICES.map((v) => v.id)).size, LOCAL_VOICES.length);
	assert.ok(listLocalVoices().every((v) => !v.installed), "en una carpeta de datos nueva no hay voces");
	assert.equal(sherpaPlatformPackage("win32", "x64"), "sherpa-onnx-win-x64");
	assert.equal(sherpaPlatformPackage("linux", "x64"), "sherpa-onnx-linux-x64");
});

test("sin la voz descargada avisa en español", async () => {
	await assert.rejects(speakLocal("hola", "piper-claude"), /no está descargada/);
	await assert.rejects(speakLocal("hola", "no-existe"), /Elige una voz/);
});
