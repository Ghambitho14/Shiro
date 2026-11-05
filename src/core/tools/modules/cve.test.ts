import { test } from "node:test";
import { ok, strictEqual } from "node:assert";
import { executeCveSearch, formatCve } from "./cve.js";

test("formatCve: formato clásico de CIRCL (id, cvss, resumen, referencias)", () => {
	const text = formatCve({
		id: "CVE-2024-3094",
		cvss: 10,
		summary: "Puerta trasera en xz/liblzma.",
		Published: "2024-03-29",
		vulnerable_product: ["cpe:/a:tukaani:xz:5.6.0", "cpe:/a:tukaani:xz:5.6.1"],
		references: ["https://example.com/a", { url: "https://example.com/b" }, "https://example.com/a"],
	});
	ok(text.startsWith("CVE-2024-3094 — CVSS 10"), text);
	ok(text.includes("Puerta trasera en xz/liblzma."));
	ok(text.includes("Productos afectados (2)"));
	ok(text.includes("- https://example.com/a"));
	ok(text.includes("- https://example.com/b"));
	// No repite la referencia duplicada.
	strictEqual(text.split("https://example.com/a").length - 1, 1);
});

test("formatCve: formato CVE 5.x (containers.cna)", () => {
	const text = formatCve({
		cveMetadata: { cveId: "CVE-2021-44228" },
		containers: {
			cna: {
				descriptions: [
					{ lang: "es", value: "No usar" },
					{ lang: "en", value: "Log4Shell remote code execution." },
				],
				metrics: [{ cvssV3_1: { baseScore: 9.8 } }],
				references: [{ url: "https://logging.apache.org/" }],
			},
		},
	});
	ok(text.startsWith("CVE-2021-44228 — CVSS 9.8"), text);
	ok(text.includes("Log4Shell remote code execution."));
	ok(text.includes("- https://logging.apache.org/"));
});

test("executeCveSearch: pide datos si no se da ni id ni product", async () => {
	const r = await executeCveSearch({});
	strictEqual(r.ok, false);
	ok(r.content.includes("id"));
});

test("executeCveSearch: avisa si el id no tiene formato de CVE", async () => {
	const r = await executeCveSearch({ id: "no-es-un-cve" });
	strictEqual(r.ok, false);
	ok(r.content.includes("CVE-AAAA-NNNN"));
});
