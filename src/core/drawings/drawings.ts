/**
 * Dibujos (tool `draw`): el modelo dice qué cajas y flechas van y aquí se acomodan solas
 * (los modelos, sobre todo los locales, se equivocan calculando posiciones).
 *
 * Cada dibujo se guarda en `data/drawings/<id>/` (escena de Excalidraw, SVG para el chat y datos)
 * y se copia a `<workspace>/Dibujos/`: con Obsidian como `.excalidraw.md` (se abre con el plugin
 * Excalidraw), si no como `.excalidraw` (se abre en excalidraw.com). El editor de la web
 * (`public/dibujo.html`) guarda los cambios en los dos sitios.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "../../config/config.js";
import { currentStorage } from "../../storage/storage.js";
import { getWorkspaceDir } from "../../workspace.js";

export const DRAWINGS_DIR = join(DATA_DIR, "drawings");

export type DrawShape = "caja" | "ovalo" | "rombo";
export type DrawNode = { id: string; text: string; color?: string; shape?: DrawShape };
export type DrawEdge = { from: string; to: string; label?: string };
export type DrawSpec = { title: string; nodes: DrawNode[]; edges: DrawEdge[]; direction?: "derecha" | "abajo" };

export type DrawingMeta = { id: string; title: string; created: number; updated: number; file: string };

/** Colores de relleno de Excalidraw, con nombre en español para el modelo. */
export const COLORS: Record<string, string> = {
	azul: "#a5d8ff",
	verde: "#b2f2bb",
	amarillo: "#ffec99",
	rojo: "#ffc9c9",
	morado: "#d0bfff",
	naranja: "#ffd8a8",
	gris: "#e9ecef",
	blanco: "#ffffff",
};
const ROTATION = ["azul", "verde", "amarillo", "morado", "naranja", "rojo"];

const FONT_SIZE = 20;
const LINE_H = 25;
const CHAR_W = 10.5;
const WRAP = 22;
const GAP_MAIN = 110;
const GAP_CROSS = 50;
const TITLE_H = 70;
const MARGIN = 40;

/** Parte el texto en líneas de como mucho `width` letras (sin cortar palabras salvo las muy largas). */
export function wrapText(text: string, width = WRAP): string[] {
	const out: string[] = [];
	for (const para of String(text).split(/\r?\n/)) {
		let line = "";
		for (let word of para.split(/\s+/).filter(Boolean)) {
			while (word.length > width) {
				if (line) {
					out.push(line);
					line = "";
				}
				out.push(word.slice(0, width));
				word = word.slice(width);
			}
			if (!line) line = word;
			else if (line.length + 1 + word.length <= width) line += " " + word;
			else {
				out.push(line);
				line = word;
			}
		}
		out.push(line);
	}
	while (out.length > 1 && !out[out.length - 1]) out.pop();
	return out.length ? out : [""];
}

export type Box = { node: DrawNode; lines: string[]; x: number; y: number; w: number; h: number; fill: string; shape: DrawShape; level: number };
export type Layout = { boxes: Box[]; width: number; height: number; down: boolean };

/** Espacio que se deja abajo (o a la derecha) para las flechas que vuelven atrás. */
const LANE = 70;

/**
 * Capas por el camino más largo desde las raíces (los ciclos se ignoran), y dentro de cada capa el
 * orden en que aparecen, corregido una vez por la media de sus padres para cruzar menos flechas.
 * Sin flechas: una cuadrícula de tarjetas (infografía).
 */
export function layout(spec: DrawSpec): Layout {
	const nodes = spec.nodes;
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const edges = spec.edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);
	const sized = nodes.map((node, i) => {
		const shape: DrawShape = node.shape === "ovalo" || node.shape === "rombo" ? node.shape : "caja";
		const lines = wrapText(node.text, shape === "rombo" ? 16 : WRAP);
		const longest = Math.max(...lines.map((l) => l.length), 4);
		let w = Math.max(150, Math.min(300, Math.round(longest * CHAR_W + 44)));
		let h = lines.length * LINE_H + 34;
		if (shape === "rombo") {
			w = Math.round(w * 1.5);
			h = Math.round(h * 1.6);
		} else if (shape === "ovalo") {
			w = Math.round(w * 1.2);
			h = Math.round(h * 1.25);
		}
		const color = node.color && COLORS[node.color.toLowerCase()] ? COLORS[node.color.toLowerCase()] : COLORS[ROTATION[i % ROTATION.length]];
		return { node, lines, x: 0, y: 0, w, h, fill: color, shape, level: 0 } as Box;
	});

	const down = spec.direction === "abajo";
	if (!edges.length) {
		// Infografía: tarjetas en filas de 3 (o 2 si son 4), del mismo tamaño para que se vea ordenado.
		const cols = nodes.length <= 3 ? nodes.length : nodes.length === 4 ? 2 : 3;
		const w = Math.max(...sized.map((b) => b.w));
		const h = Math.max(...sized.map((b) => b.h));
		sized.forEach((b, i) => {
			b.w = w;
			b.h = h;
			b.x = MARGIN + (i % cols) * (w + GAP_CROSS);
			b.y = TITLE_H + MARGIN + Math.floor(i / cols) * (h + GAP_CROSS);
		});
		const rows = Math.ceil(nodes.length / cols);
		return { boxes: sized, width: MARGIN * 2 + cols * w + (cols - 1) * GAP_CROSS, height: TITLE_H + MARGIN * 2 + rows * h + (rows - 1) * GAP_CROSS, down };
	}

	// Capas: camino más largo, sin seguir las flechas que cierran un ciclo.
	const out = nodes.map(() => [] as number[]);
	const parents = nodes.map(() => [] as number[]);
	for (const e of edges) {
		out[index.get(e.from)!].push(index.get(e.to)!);
		parents[index.get(e.to)!].push(index.get(e.from)!);
	}
	const level = nodes.map(() => 0);
	// Orden topológico por DFS: una flecha hacia algo que está en la pila cierra un ciclo y no cuenta.
	const order: number[] = [];
	const topo = (i: number, seen: Set<number>, stack: Set<number>) => {
		if (seen.has(i)) return;
		seen.add(i);
		stack.add(i);
		for (const j of out[i]) if (!stack.has(j)) topo(j, seen, stack);
		stack.delete(i);
		order.unshift(i);
	};
	const seen = new Set<number>();
	const roots = nodes.map((_, i) => i).filter((i) => parents[i].length === 0);
	for (const r of roots.length ? roots : [0]) topo(r, seen, new Set());
	for (let i = 0; i < nodes.length; i++) topo(i, seen, new Set());
	const position = new Map(order.map((n, k) => [n, k]));
	for (const i of order) {
		for (const j of out[i]) {
			// Solo hacia adelante en el orden: así un ciclo no sube las capas sin fin.
			if (position.get(j)! > position.get(i)!) level[j] = Math.max(level[j], level[i] + 1);
		}
	}

	const layers: number[][] = [];
	for (let i = 0; i < nodes.length; i++) (layers[level[i]] ??= []).push(i);
	const slot = new Map<number, number>();
	layers.forEach((layer, li) => {
		if (li > 0) {
			const avg = (i: number) => {
				const ps = parents[i].filter((p) => slot.has(p));
				return ps.length ? ps.reduce((s, p) => s + slot.get(p)!, 0) / ps.length : Number.MAX_SAFE_INTEGER;
			};
			layer.sort((a, b) => avg(a) - avg(b) || a - b);
		}
		layer.forEach((n, k) => slot.set(n, k));
	});

	// Tamaño de cada capa en el eje principal (ancho si va a la derecha) y en el cruzado.
	const mainSize = (b: Box) => (down ? b.h : b.w);
	const crossSize = (b: Box) => (down ? b.w : b.h);
	const layerMain = layers.map((l) => Math.max(...l.map((i) => mainSize(sized[i]))));
	const layerCross = layers.map((l) => l.reduce((s, i) => s + crossSize(sized[i]), 0) + (l.length - 1) * GAP_CROSS);
	const totalCross = Math.max(...layerCross);
	let main = MARGIN;
	layers.forEach((layer, li) => {
		let cross = MARGIN + (totalCross - layerCross[li]) / 2;
		for (const i of layer) {
			const b = sized[i];
			const offMain = (layerMain[li] - mainSize(b)) / 2;
			if (down) {
				b.x = cross;
				b.y = TITLE_H + main + offMain;
			} else {
				b.x = main + offMain;
				b.y = TITLE_H + cross;
			}
			cross += crossSize(b) + GAP_CROSS;
		}
		main += layerMain[li] + GAP_MAIN;
	});
	sized.forEach((b, i) => (b.level = level[i]));
	const mainTotal = main - GAP_MAIN + MARGIN;
	// Las flechas que vuelven atrás van por un carril aparte, abajo (o a la derecha si baja).
	const lane = edges.some((e) => level[index.get(e.to)!] <= level[index.get(e.from)!]) ? LANE : 0;
	const crossTotal = totalCross + MARGIN * 2 + lane;
	const width = down ? crossTotal : mainTotal;
	const height = TITLE_H + (down ? mainTotal : crossTotal);
	return { boxes: sized, width: Math.max(width, spec.title.length * 14 + MARGIN * 2), height, down };
}

/** Punto del borde de la caja en la recta que va de su centro hacia (tx, ty). */
export function borderPoint(b: Box, tx: number, ty: number): [number, number] {
	const cx = b.x + b.w / 2;
	const cy = b.y + b.h / 2;
	const dx = tx - cx;
	const dy = ty - cy;
	if (!dx && !dy) return [cx, cy];
	const hw = b.w / 2;
	const hh = b.h / 2;
	let t: number;
	if (b.shape === "rombo") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
	else if (b.shape === "ovalo") t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
	else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
	return [cx + dx * t, cy + dy * t];
}

function edgePoints(a: Box, b: Box): { x1: number; y1: number; x2: number; y2: number } {
	const [x1, y1] = borderPoint(a, b.x + b.w / 2, b.y + b.h / 2);
	const [x2, y2] = borderPoint(b, a.x + a.w / 2, a.y + a.h / 2);
	// Un poco de aire entre la flecha y la caja.
	const len = Math.hypot(x2 - x1, y2 - y1) || 1;
	const ux = (x2 - x1) / len;
	const uy = (y2 - y1) / len;
	const gap = Math.min(8, len / 4);
	return { x1: x1 + ux * gap, y1: y1 + uy * gap, x2: x2 - ux * gap, y2: y2 - uy * gap };
}

export type Route = { points: [number, number][]; label: [number, number]; back: boolean };

/**
 * Por dónde va una flecha. Hacia adelante, recta de borde a borde. Si vuelve atrás (o va a la misma
 * capa), sale por abajo de la caja, baja al carril y vuelve a subir: así no tapa las cajas de en medio.
 */
export function routeEdge(a: Box, b: Box, lay: Layout): Route {
	if (b.level > a.level) {
		const p = edgePoints(a, b);
		return { points: [[p.x1, p.y1], [p.x2, p.y2]], label: [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2], back: false };
	}
	if (lay.down) {
		const lane = Math.max(...lay.boxes.map((x) => x.x + x.w)) + LANE * 0.6;
		const p0: [number, number] = [a.x + a.w + 8, a.y + a.h / 2];
		const p2: [number, number] = [b.x + b.w + 8, b.y + b.h / 2];
		return { points: [p0, [lane, (p0[1] + p2[1]) / 2], p2], label: [lane, (p0[1] + p2[1]) / 2], back: true };
	}
	const lane = Math.max(...lay.boxes.map((x) => x.y + x.h)) + LANE * 0.6;
	const p0: [number, number] = [a.x + a.w / 2, a.y + a.h + 8];
	const p2: [number, number] = [b.x + b.w / 2, b.y + b.h + 8];
	return { points: [p0, [(p0[0] + p2[0]) / 2, lane], p2], label: [(p0[0] + p2[0]) / 2, lane], back: true };
}

/** La ruta como trazo SVG: recta, o una curva que pasa por el punto del carril. */
function routePath(r: Route): string {
	const [p0, p1, p2] = r.points;
	if (!p2) return `M${round(p0[0])},${round(p0[1])} L${round(p1[0])},${round(p1[1])}`;
	// Bézier cuadrática que pasa por p1 en t = 0.5: control = 2·p1 − (p0 + p2)/2.
	const cx = 2 * p1[0] - (p0[0] + p2[0]) / 2;
	const cy = 2 * p1[1] - (p0[1] + p2[1]) / 2;
	return `M${round(p0[0])},${round(p0[1])} Q${round(cx)},${round(cy)} ${round(p2[0])},${round(p2[1])}`;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const round = (n: number) => Math.round(n * 10) / 10;
const FONT = "Excalifont, Virgil, 'Segoe Print', 'Comic Sans MS', cursive";

/** El dibujo como SVG para el chat (mismo acomodo que la escena de Excalidraw). */
export function renderSvg(spec: DrawSpec): string {
	const lay = layout(spec);
	const { boxes, width, height } = lay;
	const byId = new Map(boxes.map((b) => [b.node.id, b]));
	const parts: string[] = [];
	parts.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}" font-family="${FONT}">`,
		`<defs><marker id="flecha" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke="#1e1e1e" stroke-width="1.6"/></marker></defs>`,
		`<rect width="100%" height="100%" fill="#ffffff"/>`,
		`<text x="${round(width / 2)}" y="${MARGIN + 8}" text-anchor="middle" font-size="28" fill="#1e1e1e">${xmlEscape(spec.title)}</text>`,
	);
	for (const e of spec.edges) {
		const a = byId.get(e.from);
		const b = byId.get(e.to);
		if (!a || !b || a === b) continue;
		const route = routeEdge(a, b, lay);
		parts.push(`<path d="${routePath(route)}" fill="none" stroke="#1e1e1e" stroke-width="2" stroke-linecap="round" marker-end="url(#flecha)"/>`);
		if (e.label) {
			const [mx, my] = route.label;
			const w = e.label.length * 8.5 + 14;
			parts.push(
				`<rect x="${round(mx - w / 2)}" y="${round(my - 13)}" width="${round(w)}" height="24" rx="6" fill="#ffffff"/>`,
				`<text x="${round(mx)}" y="${round(my + 5)}" text-anchor="middle" font-size="16" fill="#495057">${xmlEscape(e.label)}</text>`,
			);
		}
	}
	for (const b of boxes) {
		const stroke = `stroke="#1e1e1e" stroke-width="2" fill="${b.fill}"`;
		if (b.shape === "ovalo") parts.push(`<ellipse cx="${round(b.x + b.w / 2)}" cy="${round(b.y + b.h / 2)}" rx="${round(b.w / 2)}" ry="${round(b.h / 2)}" ${stroke}/>`);
		else if (b.shape === "rombo") {
			const cx = b.x + b.w / 2;
			const cy = b.y + b.h / 2;
			parts.push(`<polygon points="${round(cx)},${round(b.y)} ${round(b.x + b.w)},${round(cy)} ${round(cx)},${round(b.y + b.h)} ${round(b.x)},${round(cy)}" ${stroke} stroke-linejoin="round"/>`);
		} else parts.push(`<rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="14" ${stroke}/>`);
		const top = b.y + b.h / 2 - ((b.lines.length - 1) * LINE_H) / 2 + 7;
		const tspans = b.lines.map((l, k) => `<tspan x="${round(b.x + b.w / 2)}" y="${round(top + k * LINE_H)}">${xmlEscape(l)}</tspan>`).join("");
		parts.push(`<text text-anchor="middle" font-size="${FONT_SIZE}" fill="#1e1e1e">${tspans}</text>`);
	}
	parts.push("</svg>");
	return parts.join("");
}

let seedCounter = 1;
const seed = () => (Math.floor(Math.random() * 2 ** 30) + seedCounter++) | 0;
const elId = () => randomBytes(10).toString("base64url");

function base(type: string, x: number, y: number, w: number, h: number) {
	return {
		id: elId(),
		type,
		x: round(x),
		y: round(y),
		width: round(w),
		height: round(h),
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [] as string[],
		frameId: null,
		roundness: null as null | { type: number },
		seed: seed(),
		version: 1,
		versionNonce: seed(),
		isDeleted: false,
		boundElements: [] as { type: string; id: string }[],
		updated: Date.now(),
		link: null,
		locked: false,
	};
}

function textEl(text: string, x: number, y: number, w: number, h: number, containerId: string | null, size = FONT_SIZE) {
	return {
		...base("text", x, y, w, h),
		text,
		originalText: text,
		fontSize: size,
		fontFamily: 5,
		textAlign: "center",
		verticalAlign: "middle",
		containerId,
		autoResize: true,
		lineHeight: 1.25,
	};
}

export type ExcalidrawScene = { type: "excalidraw"; version: 2; source: string; elements: Record<string, unknown>[]; appState: Record<string, unknown>; files: Record<string, unknown> };

/** El dibujo como escena de Excalidraw (cajas con su texto dentro y flechas pegadas a las cajas). */
export function buildScene(spec: DrawSpec): ExcalidrawScene {
	const lay = layout(spec);
	const { boxes, width } = lay;
	const elements: Record<string, unknown>[] = [];
	const shapeIds = new Map<string, ReturnType<typeof base>>();
	const titleW = spec.title.length * 15;
	elements.push(textEl(spec.title, width / 2 - titleW / 2, MARGIN - 16, titleW, 35, null, 28));
	for (const b of boxes) {
		const type = b.shape === "ovalo" ? "ellipse" : b.shape === "rombo" ? "diamond" : "rectangle";
		const shape = base(type, b.x, b.y, b.w, b.h);
		shape.backgroundColor = b.fill;
		shape.roundness = type === "rectangle" ? { type: 3 } : { type: 2 };
		const text = b.lines.join("\n");
		const tw = Math.max(...b.lines.map((l) => l.length)) * CHAR_W;
		const th = b.lines.length * LINE_H;
		const t = textEl(text, b.x + (b.w - tw) / 2, b.y + (b.h - th) / 2, tw, th, shape.id);
		shape.boundElements.push({ type: "text", id: t.id });
		shapeIds.set(b.node.id, shape);
		elements.push(shape, t);
	}
	const byId = new Map(boxes.map((b) => [b.node.id, b]));
	for (const e of spec.edges) {
		const a = byId.get(e.from);
		const b = byId.get(e.to);
		const sa = shapeIds.get(e.from);
		const sb = shapeIds.get(e.to);
		if (!a || !b || !sa || !sb || a === b) continue;
		const route = routeEdge(a, b, lay);
		const [x0, y0] = route.points[0];
		const xs = route.points.map((q) => q[0]);
		const ys = route.points.map((q) => q[1]);
		const arrow = {
			...base("arrow", x0, y0, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
			roundness: { type: 2 },
			points: route.points.map(([x, y]) => [round(x - x0), round(y - y0)]),
			lastCommittedPoint: null,
			startBinding: { elementId: sa.id, focus: 0, gap: 8 },
			endBinding: { elementId: sb.id, focus: 0, gap: 8 },
			startArrowhead: null,
			endArrowhead: "arrow",
			elbowed: false,
		};
		sa.boundElements.push({ type: "arrow", id: arrow.id });
		sb.boundElements.push({ type: "arrow", id: arrow.id });
		elements.push(arrow);
		if (e.label) {
			const lw = e.label.length * 9;
			const label = textEl(e.label, route.label[0] - lw / 2, route.label[1] - 12, lw, 25, arrow.id, 16);
			arrow.boundElements.push({ type: "text", id: label.id });
			elements.push(label);
		}
	}
	return { type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
}

/** Formato del plugin Excalidraw de Obsidian (escena sin comprimir, que el plugin acepta). */
export function toObsidianMarkdown(scene: ExcalidrawScene): string {
	const texts = scene.elements
		.filter((e) => e.type === "text" && typeof e.text === "string")
		.map((e) => `${String(e.text).replace(/\n/g, " ")} ^${String(e.id)}`)
		.join("\n\n");
	return `---
excalidraw-plugin: parsed
tags: [excalidraw]
---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==

# Excalidraw Data

## Text Elements
${texts}

%%
## Drawing
\`\`\`json
${JSON.stringify(scene, null, "\t")}
\`\`\`
%%
`;
}

const safeName = (s: string) =>
	s
		.replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 60) || "Dibujo";

function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, data, "utf8");
	renameSync(tmp, file);
}

const validId = (id: string) => /^[a-f0-9]{16}$/.test(id);

/** Escribe la copia del workspace (Obsidian o .excalidraw). Devuelve la ruta relativa al workspace. */
function writeWorkspaceCopy(title: string, created: number, scene: ExcalidrawScene, previous?: string): string {
	const obsidian = currentStorage().kind === "obsidian";
	const dir = join(getWorkspaceDir(), "Dibujos");
	mkdirSync(dir, { recursive: true });
	let rel = previous;
	const wantExt = obsidian ? ".excalidraw.md" : ".excalidraw";
	if (!rel || !rel.endsWith(wantExt)) {
		const day = new Date(created).toISOString().slice(0, 10);
		let name = `${safeName(title)} ${day}`;
		let n = 2;
		while (existsSync(join(dir, name + wantExt))) name = `${safeName(title)} ${day} (${n++})`;
		rel = `Dibujos/${name}${wantExt}`;
	}
	const full = join(getWorkspaceDir(), rel);
	writeAtomic(full, obsidian ? toObsidianMarkdown(scene) : JSON.stringify(scene, null, "\t"));
	return rel;
}

/** Crea un dibujo nuevo y lo guarda. */
export function createDrawing(spec: DrawSpec): DrawingMeta & { svg: string } {
	const id = randomBytes(8).toString("hex");
	const scene = buildScene(spec);
	const svg = renderSvg(spec);
	const now = Date.now();
	const dir = join(DRAWINGS_DIR, id);
	mkdirSync(dir, { recursive: true });
	const file = writeWorkspaceCopy(spec.title, now, scene);
	const meta: DrawingMeta = { id, title: spec.title, created: now, updated: now, file };
	writeAtomic(join(dir, "scene.json"), JSON.stringify(scene));
	writeAtomic(join(dir, "drawing.svg"), svg);
	writeAtomic(join(dir, "meta.json"), JSON.stringify(meta));
	return { ...meta, svg };
}

export function readDrawingMeta(id: string): DrawingMeta | null {
	if (!validId(id)) return null;
	try {
		return JSON.parse(readFileSync(join(DRAWINGS_DIR, id, "meta.json"), "utf8")) as DrawingMeta;
	} catch {
		return null;
	}
}

export function readDrawingScene(id: string): ExcalidrawScene | null {
	if (!validId(id)) return null;
	try {
		return JSON.parse(readFileSync(join(DRAWINGS_DIR, id, "scene.json"), "utf8")) as ExcalidrawScene;
	} catch {
		return null;
	}
}

export function readDrawingSvg(id: string): string | null {
	if (!validId(id)) return null;
	try {
		return readFileSync(join(DRAWINGS_DIR, id, "drawing.svg"), "utf8");
	} catch {
		return null;
	}
}

/** Un SVG que viene del navegador: sin scripts, eventos ni enlaces a otros sitios. */
export function isSafeSvg(svg: string): boolean {
	if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) return false;
	return !/<script|<foreignObject|\son\w+\s*=|javascript:|<iframe|<embed|<object/i.test(svg);
}

/** Guarda lo que el usuario cambió en el editor (escena y SVG que exporta Excalidraw). */
export function saveDrawing(id: string, scene: unknown, svg: string): DrawingMeta | { error: string } {
	const meta = readDrawingMeta(id);
	if (!meta) return { error: "Ese dibujo no existe." };
	const s = scene as ExcalidrawScene;
	if (!s || typeof s !== "object" || !Array.isArray(s.elements)) return { error: "La escena no es válida." };
	if (typeof svg !== "string" || !isSafeSvg(svg)) return { error: "La imagen del dibujo no es válida." };
	const clean: ExcalidrawScene = {
		type: "excalidraw",
		version: 2,
		source: "https://excalidraw.com",
		elements: s.elements,
		appState: { viewBackgroundColor: (s.appState?.viewBackgroundColor as string) || "#ffffff", gridSize: null },
		files: s.files && typeof s.files === "object" ? s.files : {},
	};
	const dir = join(DRAWINGS_DIR, id);
	writeAtomic(join(dir, "scene.json"), JSON.stringify(clean));
	writeAtomic(join(dir, "drawing.svg"), svg);
	const updated: DrawingMeta = { ...meta, updated: Date.now(), file: writeWorkspaceCopy(meta.title, meta.created, clean, meta.file) };
	writeAtomic(join(dir, "meta.json"), JSON.stringify(updated));
	return updated;
}
