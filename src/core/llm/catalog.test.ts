import { test } from "node:test";
import { strictEqual } from "node:assert";
import { resolveModelId, setCatalogForTests } from "./catalog.js";

const kimi = { name: "Kimi K3", api: "chat" as const, vision: true, temperature: true, deprecated: false };

test("resolveModelId acepta el id o el nombre visible del modelo", () => {
	setCatalogForTests({ fetchedAt: Date.now(), providers: { "opencode-go": { "kimi-k3": kimi } } });
	strictEqual(resolveModelId("opencode-go", "kimi-k3"), "kimi-k3");
	strictEqual(resolveModelId("opencode-go", "Kimi K3"), "kimi-k3");
	strictEqual(resolveModelId("opencode-go", " kimi k3 "), "kimi-k3");
	// Lo desconocido se deja tal cual: el servidor dirá si existe.
	strictEqual(resolveModelId("opencode-go", "modelo-nuevo"), "modelo-nuevo");
});

test("resolveModelId sin catálogo no cambia nada", () => {
	setCatalogForTests(null);
	strictEqual(resolveModelId("opencode-go", "Kimi K3"), "Kimi K3");
});
