import { after, before, test } from "node:test";
import { ok, strictEqual } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { executeFetchUrl, FETCH_MAX_BYTES, htmlToText, pagePart } from "./fetch.js";

test("htmlToText deja el texto y quita scripts, estilos y etiquetas", () => {
	const html = `<!doctype html><html><head><title>Mi &amp; página</title><style>body{color:red}</style></head>
<body><script>var x = "<p>no</p>";</script><h1>Hola</h1><p>Uno&nbsp;dos &#241; &#x00e9;</p>
<ul><li>a</li><li>b</li></ul><!-- comentario --><table><tr><td>c1</td><td>c2</td></tr></table></body></html>`;
	strictEqual(htmlToText(html), "# Mi & página\n\nHola\nUno dos ñ é\n- a\n- b\nc1 | c2 |");
});

let server: Server;
let base = "";
// Una página de ~400 KB: casi todo script, como muchas webs de hoy.
const bigPage = `<html><head><title>Grande</title></head><body><script>${"x".repeat(400 * 1024)}</script><p>Lo importante</p></body></html>`;

before(async () => {
	server = createServer((req, res) => {
		if (req.url === "/big") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(bigPage);
		} else if (req.url === "/huge") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("a".repeat(FETCH_MAX_BYTES + 1000));
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("fetch_url lee una página de más de 150 KB y devuelve su texto", async () => {
	const r = await executeFetchUrl({ url: `${base}/big` });
	strictEqual(r.ok, true);
	strictEqual(r.content, "# Grande\n\nLo importante");
});

test("fetch_url recorta lo que pasa del máximo en vez de fallar", async () => {
	const r = await executeFetchUrl({ url: `${base}/huge` });
	strictEqual(r.ok, true);
	// Llega por partes: el principio, con cómo seguir.
	ok(r.content.startsWith("[Página (caracteres 0–11700 de "), r.content.slice(0, 60));
	ok(r.content.includes("a".repeat(1000)));
	ok(/Sigue con offset=11700\.\]$/.test(r.content), r.content.slice(-80));
	ok(r.content.length <= 12_000);
	// El final (sin volver a bajarla) trae el aviso de que la página era más larga.
	const end = await executeFetchUrl({ url: `${base}/huge`, offset: FETCH_MAX_BYTES - 50 });
	ok(end.ok && end.content.endsWith("(página recortada: solo se leyeron los primeros 3 MB)"), end.content.slice(-80));
	strictEqual((await executeFetchUrl({ url: `${base}/huge`, offset: FETCH_MAX_BYTES * 2 })).ok, false);
});

test("fetch_url con find trae solo los párrafos que tienen las palabras", () => {
	const page = ["# Tienda", "Envíos a todo Chile.", "El precio del envío es 3.990 pesos.", "Contacto: hola@ejemplo.cl", "Otro párrafo."].join("\n");
	const found = pagePart(page, { find: "precio envio" }, 5000);
	ok(found.startsWith("1 coincidencia de «precio envio» en la página:"), found);
	ok(found.includes("El precio del envío es 3.990 pesos.") && found.includes("Envíos a todo Chile.") && !found.includes("Otro párrafo."));
	ok(pagePart(page, { find: "garantía" }, 5000).startsWith("No encontré «garantía»"));
	// Una página corta va entera.
	strictEqual(pagePart(page, {}, 5000), page);
});

test("fetch_url sigue avisando de los errores HTTP", async () => {
	const r = await executeFetchUrl({ url: `${base}/nada` });
	strictEqual(r.ok, false);
	strictEqual(r.content, "HTTP 404: Not Found");
});
