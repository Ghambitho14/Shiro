import { test } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert";
import { addressKind, isDangerousHost, checkUrlAllowed } from "./addressGuard.js";

test("addressKind clasifica IPv4", () => {
	strictEqual(addressKind("169.254.169.254"), "metadata"); // metadatos de nube
	strictEqual(addressKind("169.254.0.1"), "metadata");
	strictEqual(addressKind("127.0.0.1"), "private");
	strictEqual(addressKind("10.0.0.5"), "private");
	strictEqual(addressKind("172.16.0.1"), "private");
	strictEqual(addressKind("172.31.255.1"), "private");
	strictEqual(addressKind("192.168.1.1"), "private");
	strictEqual(addressKind("100.64.0.1"), "private"); // CGNAT / Tailscale
	strictEqual(addressKind("8.8.8.8"), "public");
	strictEqual(addressKind("172.15.0.1"), "public"); // justo fuera de 172.16/12
	strictEqual(addressKind("1.1.1.1"), "public");
});

test("addressKind clasifica IPv6", () => {
	strictEqual(addressKind("::1"), "private");
	strictEqual(addressKind("[::1]"), "private");
	strictEqual(addressKind("fd00:ec2::254"), "metadata"); // metadatos IPv6 de AWS
	strictEqual(addressKind("fe80::1"), "metadata"); // enlace local
	strictEqual(addressKind("fc00::1"), "private"); // ULA
	strictEqual(addressKind("::ffff:192.168.0.1"), "private"); // IPv4 mapeada
	strictEqual(addressKind("2606:4700:4700::1111"), "public");
});

test("addressKind: un nombre de dominio no es IP (se resuelve aparte)", () => {
	strictEqual(addressKind("example.com"), "public");
});

test("isDangerousHost marca solo metadatos / enlace local", () => {
	strictEqual(isDangerousHost("169.254.169.254"), true);
	strictEqual(isDangerousHost("metadata.google.internal"), true);
	strictEqual(isDangerousHost("[fe80::1]"), true);
	strictEqual(isDangerousHost("127.0.0.1"), false); // la red local directa se permite
	strictEqual(isDangerousHost("192.168.1.1"), false);
	strictEqual(isDangerousHost("example.com"), false);
});

test("checkUrlAllowed: metadatos siempre bloqueados fuera de Hacking", async () => {
	deepStrictEqual((await checkUrlAllowed("http://169.254.169.254/latest/meta-data/", { cameFromPublic: false, hacking: false })).allowed, false);
	// En Hacking no se bloquea nada.
	deepStrictEqual((await checkUrlAllowed("http://169.254.169.254/latest/meta-data/", { cameFromPublic: false, hacking: true })).allowed, true);
});

test("checkUrlAllowed: la red local directa se permite; por redirección pública se bloquea", async () => {
	// El usuario pide un servidor local directamente: permitido.
	deepStrictEqual((await checkUrlAllowed("http://127.0.0.1:1234/v1/models", { cameFromPublic: false, hacking: false })).allowed, true);
	deepStrictEqual((await checkUrlAllowed("http://192.168.1.50:8080/", { cameFromPublic: false, hacking: false })).allowed, true);
	// Una web pública que redirige a la red interna: bloqueado.
	deepStrictEqual((await checkUrlAllowed("http://192.168.1.50:8080/", { cameFromPublic: true, hacking: false })).allowed, false);
});

test("checkUrlAllowed: una web pública normal pasa", async () => {
	deepStrictEqual((await checkUrlAllowed("https://8.8.8.8/", { cameFromPublic: true, hacking: false })).allowed, true);
});
