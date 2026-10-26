import { test } from "node:test";
import { strictEqual, ok, throws } from "node:assert";
import { formatSnapshot, isShiroUrl, normalizeUrl } from "./pageModel.js";
import { parseBrowserInput } from "../../panelsApi.js";

test("normalizeUrl: direcciones, búsquedas y protocolos", () => {
	strictEqual(normalizeUrl("youtube.com"), "https://youtube.com/");
	strictEqual(normalizeUrl("https://es.wikipedia.org/wiki/Gato"), "https://es.wikipedia.org/wiki/Gato");
	strictEqual(normalizeUrl("localhost:3000/app"), "http://localhost:3000/app");
	ok(normalizeUrl("gatos bonitos").startsWith("https://duckduckgo.com/?q=gatos%20bonitos"));
	ok(normalizeUrl("gatos").startsWith("https://duckduckgo.com/?q=gatos"));
	throws(() => normalizeUrl("file:///C:/Windows/win.ini"), /http o https/);
	throws(() => normalizeUrl("javascript:alert(1)"), /http o https/);
	throws(() => normalizeUrl("C:\\Users\\yo"), /http o https/);
	throws(() => normalizeUrl("   "), /Indica/);
});

test("la web de Shiro no se abre en su propio navegador", () => {
	const port = Number(process.env.PORT) || 1406;
	ok(isShiroUrl(`http://127.0.0.1:${port}/api/state`));
	ok(isShiroUrl(`http://localhost:${port}/`));
	strictEqual(isShiroUrl("http://localhost:5173/"), false);
	strictEqual(isShiroUrl("https://example.com/"), false);
	throws(() => normalizeUrl(`127.0.0.1:${port}/api/state`), /Shiro/);
});

test("formatSnapshot: elementos numerados, visibles primero, y aviso de texto recortado", () => {
	const text = formatSnapshot({
		title: "Buscador",
		url: "https://ejemplo.com/",
		els: [
			{ ref: 1, kind: "campo", name: "Buscar", extra: '= "gatos"', inView: true },
			{ ref: 2, kind: "botón", name: "Enviar", extra: "", inView: true },
			{ ref: 3, kind: "enlace", name: "Contacto", extra: "", inView: false },
		],
		text: "Hola mundo",
		truncated: true,
		scrollY: 0,
		scrollMax: 900,
	});
	ok(text.includes('[1] campo "Buscar" = "gatos"'));
	ok(text.includes("Posición: arriba del todo"));
	ok(text.indexOf("[2] botón") < text.indexOf("Fuera de la vista:"));
	ok(text.indexOf("Fuera de la vista:") < text.indexOf("[3] enlace"));
	ok(text.includes("Hay más texto"));
});

test("parseBrowserInput valida los eventos del panel", () => {
	strictEqual(parseBrowserInput({ type: "click", x: "10", y: 5 }), null);
	strictEqual(parseBrowserInput({ type: "key", key: "" }), null);
	strictEqual(parseBrowserInput({ type: "nope" }), null);
	const click = parseBrowserInput({ type: "click", x: 10, y: 20, button: "evil" });
	strictEqual(click?.type, "click");
	strictEqual(click && "button" in click ? click.button : "", "left");
	const key = parseBrowserInput({ type: "key", key: "Enter", ctrl: "yes" });
	strictEqual(key && "ctrl" in key ? key.ctrl : true, false);
});
