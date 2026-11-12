import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, getUpdateState, installUpdate, pickInstaller, UPDATE_REPO } from "./updater.js";

test("comparar versiones por números", () => {
	assert.equal(compareVersions("0.2.10", "0.2.9"), 1);
	assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
	assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
	assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("elegir el instalador de una versión de GitHub", () => {
	const url = (name: string) => `https://github.com/${UPDATE_REPO}/releases/download/v0.3.0/${name}`;
	const asset = { name: "AkuSetup-0.3.0.exe", size: 30_000_000, browser_download_url: url("AkuSetup-0.3.0.exe"), digest: `sha256:${"a".repeat(64)}` };
	const ok = pickInstaller({ tag_name: "v0.3.0", body: "Novedades", html_url: "https://x", assets: [asset] });
	assert.equal(ok?.version, "0.3.0");
	assert.equal(ok?.notes, "Novedades");
	assert.equal(pickInstaller({ tag_name: "v0.3.0", assets: [{ ...asset, digest: null }] }), null, "sin huella no");
	assert.equal(pickInstaller({ tag_name: "v0.3.0", assets: [{ ...asset, browser_download_url: "https://otro.com/AkuSetup-0.3.0.exe" }] }), null, "solo del repo fijo");
	assert.equal(pickInstaller({ tag_name: "v0.3.0", prerelease: true, assets: [asset] }), null, "las de prueba no");
	assert.equal(pickInstaller({ tag_name: "v0.3.0", assets: [{ ...asset, name: "AkuSetup-0.2.0.exe" }] }), null, "el nombre tiene que ser el de esa versión");
	assert.equal(pickInstaller({ tag_name: "beta", assets: [asset] }), null);
});

test("desde el código no se instala solo", async () => {
	assert.equal(getUpdateState().canInstall, false);
	await assert.rejects(installUpdate(() => assert.fail("no debe cerrar Aku")), /git pull/);
	assert.equal(getUpdateState().phase, "error");
});
