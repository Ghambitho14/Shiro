import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildScene, createDrawing, isSafeSvg, layout, readDrawingScene, readDrawingSvg, renderSvg, routeEdge, saveDrawing, toObsidianMarkdown, wrapText, type DrawSpec } from "./drawings.js";
import { drawSchema } from "../tools/schemas.js";
import { getWorkspaceDir } from "../../workspace.js";

const flow: DrawSpec = {
	title: "Un pedido",
	nodes: [
		{ id: "a", text: "Cliente pide" },
		{ id: "b", text: "Cocina prepara el pedido con calma" },
		{ id: "c", text: "¿Hay repartidor?", shape: "rombo" },
		{ id: "d", text: "Entrega" },
		{ id: "e", text: "Espera" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
		{ from: "c", to: "d", label: "sí" },
		{ from: "c", to: "e", label: "no" },
		{ from: "e", to: "c" },
	],
};

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("wrapText corta por palabras y parte las muy largas", () => {
	assert.deepEqual(wrapText("uno dos tres cuatro cinco seis", 10), ["uno dos", "tres", "cuatro", "cinco seis"]);
	assert.deepEqual(wrapText("supercalifragilístico", 8), ["supercal", "ifragilí", "stico"]);
	assert.deepEqual(wrapText(""), [""]);
});

test("layout: capas hacia la derecha, sin cajas encimadas y con un ciclo", () => {
	const { boxes, width, height } = layout(flow);
	const at = (id: string) => boxes.find((b) => b.node.id === id)!;
	assert.ok(at("a").x < at("b").x && at("b").x < at("c").x && at("c").x < at("d").x, "cada paso más a la derecha");
	assert.equal(at("d").x, at("e").x, "las dos salidas de la decisión en la misma capa");
	for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${boxes[i].node.id} y ${boxes[j].node.id} se encima`);
	for (const b of boxes) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= width && b.y + b.h <= height, `${b.node.id} dentro del dibujo`);
});

test("la flecha que vuelve atrás va por el carril de abajo, no por encima de las cajas", () => {
	const lay = layout(flow);
	const at = (id: string) => lay.boxes.find((b) => b.node.id === id)!;
	const back = routeEdge(at("e"), at("c"), lay);
	assert.ok(back.back);
	assert.equal(back.points.length, 3);
	const bottom = Math.max(...lay.boxes.map((b) => b.y + b.h));
	assert.ok(back.points[1][1] > bottom && back.points[1][1] < lay.height, "el carril queda debajo de todo y dentro del dibujo");
	assert.ok(!routeEdge(at("a"), at("b"), lay).back);
	const svg = renderSvg(flow);
	assert.match(svg, /<path d="M[\d.,]+ Q/);
});

test("layout: hacia abajo y sin flechas es una cuadrícula", () => {
	const down = layout({ ...flow, direction: "abajo" });
	const at = (id: string) => down.boxes.find((b) => b.node.id === id)!;
	assert.ok(at("a").y < at("b").y && at("b").y < at("c").y);
	const grid = layout({ title: "Ideas", nodes: [1, 2, 3, 4, 5].map((n) => ({ id: `n${n}`, text: `Idea ${n}` })), edges: [] });
	assert.equal(new Set(grid.boxes.map((b) => b.y)).size, 2, "5 tarjetas en 2 filas");
});

test("la escena de Excalidraw tiene cada caja con su texto y flechas pegadas", () => {
	const scene = buildScene(flow);
	const shapes = scene.elements.filter((e) => ["rectangle", "diamond", "ellipse"].includes(String(e.type)));
	const arrows = scene.elements.filter((e) => e.type === "arrow");
	assert.equal(shapes.length, 5);
	assert.equal(arrows.length, 5);
	assert.ok(scene.elements.some((e) => e.type === "diamond"));
	for (const a of arrows) {
		const ids = [(a.startBinding as { elementId: string }).elementId, (a.endBinding as { elementId: string }).elementId];
		for (const id of ids) {
			const shape = shapes.find((s) => s.id === id)!;
			assert.ok((shape.boundElements as { id: string }[]).some((b) => b.id === a.id), "la caja conoce su flecha");
		}
	}
	const md = toObsidianMarkdown(scene);
	assert.match(md, /^---\nexcalidraw-plugin: parsed/);
	assert.match(md, /## Drawing\n```json\n\{/);
	assert.match(md, /Cliente pide \^/);
});

test("el SVG escapa el texto del modelo", () => {
	const svg = renderSvg({ title: "<script>alert(1)</script>", nodes: [{ id: "x", text: 'a & b "c" <d>' }], edges: [] });
	assert.ok(!svg.includes("<script>"));
	assert.match(svg, /a &amp; b &quot;c&quot; &lt;d&gt;/);
	assert.ok(isSafeSvg(svg));
	assert.ok(!isSafeSvg('<svg onload="alert(1)"></svg>'));
	assert.ok(!isSafeSvg("<svg><script>x</script></svg>"));
	assert.ok(!isSafeSvg("<html><svg></svg></html>"));
});

test("crear y guardar un dibujo: data/drawings y copia en Dibujos/", () => {
	const d = createDrawing(flow);
	assert.match(d.id, /^[a-f0-9]{16}$/);
	assert.match(d.file, /^Dibujos\/Un pedido \d{4}-\d{2}-\d{2}\.excalidraw$/);
	assert.ok(existsSync(join(getWorkspaceDir(), d.file)));
	assert.ok(readDrawingSvg(d.id)?.startsWith("<svg"));
	const scene = readDrawingScene(d.id)!;
	const edited = { ...scene, elements: scene.elements.slice(0, 2) };
	const saved = saveDrawing(d.id, edited, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	assert.ok(!("error" in saved));
	assert.equal(readDrawingScene(d.id)!.elements.length, 2);
	assert.equal(JSON.parse(readFileSync(join(getWorkspaceDir(), d.file), "utf8")).elements.length, 2);
	assert.deepEqual(saveDrawing(d.id, edited, "<svg onload=x></svg>"), { error: "La imagen del dibujo no es válida." });
	assert.deepEqual(saveDrawing("../../etc", edited, "<svg></svg>"), { error: "Ese dibujo no existe." });
	assert.equal(readDrawingScene("../meta"), null);
});

test("drawSchema acepta los nombres que usan los modelos y avisa de flechas rotas", () => {
	const ok = drawSchema.parse({ title: "T", boxes: [{ id: "a", label: "Uno", shape: "decision" }, "Dos"], arrows: [{ source: "a", target: "Dos", text: "va" }], direction: "down" });
	assert.equal(ok.nodes[0].text, "Uno");
	assert.equal(ok.nodes[0].shape, "rombo");
	assert.equal(ok.nodes[1].id, "Dos");
	assert.deepEqual(ok.edges[0], { from: "a", to: "Dos", label: "va" });
	assert.equal(ok.direction, "abajo");
	const bad = drawSchema.safeParse({ title: "T", nodes: [{ id: "a", text: "A" }], edges: [{ from: "a", to: "zz" }] });
	assert.ok(!bad.success);
	assert.match(bad.error.issues[0].message, /no está en nodes/);
});
