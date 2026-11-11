import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { crc32 } from "node:zlib";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-projects-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
after(() => rmSync(TMP, { recursive: true, force: true }));

const projects = await import("./projects.js");
const { extractText } = await import("./documents.js");
const { executeTool } = await import("../tools/tools.js");
const { describeRiskyAction } = await import("../tools/approval.js");
const { buildContext } = await import("../agent/ContextBuilder.js");

/** Texto de un resultado de tool, haya ido bien o mal. */
const out = (r: { ok: true; content: string } | { ok: false; error: string }) => (r.ok ? r.content : r.error);

/** Carpeta "del usuario" que se vincula en las pruebas. */
const FOLDER = join(TMP, "MiTienda");
mkdirSync(join(FOLDER, "src"), { recursive: true });
mkdirSync(join(FOLDER, "node_modules", "lib"), { recursive: true });
writeFileSync(join(FOLDER, "precios.csv"), "producto,precio\narepa,3\ncachapa,5\n");
writeFileSync(join(FOLDER, "src", "app.ts"), "export const tienda = 'abierta';\n");
writeFileSync(join(FOLDER, "node_modules", "lib", "index.js"), "module.exports = 'no se lista';\n");

/** .docx mínimo (zip sin comprimir) con un párrafo. */
function makeDocx(text: string): Buffer {
	const files: Record<string, string> = {
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
	};
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const data = Buffer.from(content, "utf-8");
		const nameBuf = Buffer.from(name, "utf-8");
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBuf, data);
		centrals.push(central, nameBuf);
		offset += 30 + nameBuf.length + data.length;
	}
	const dir = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, dir, end]);
}

/** PDF mínimo de una página con una línea de texto. */
function makePdf(text: string): Buffer {
	const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((o, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = pdf.length;
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}

test("crear, editar, listar y borrar proyectos", () => {
	assert.throws(() => projects.createProject({ name: "  " }), /nombre/);
	const p = projects.createProject({ name: "Tesis", description: "Mi máster" });
	assert.equal(projects.getProject(p.id)?.name, "Tesis");
	const edited = projects.updateProject(p.id, { instructions: "Responde formal." });
	assert.equal(edited?.instructions, "Responde formal.");
	assert.ok(projects.listProjects().some((x) => x.id === p.id));
	assert.equal(projects.getProject("../config"), null);
	assert.equal(projects.deleteProject(p.id), true);
	assert.equal(projects.getProject(p.id), null);
});

test("vincular carpetas: solo carpetas concretas que existan", () => {
	const p = projects.createProject({ name: "Tienda" });
	assert.throws(() => projects.addFolder(p.id, join(TMP, "no-existe")), /No encuentro/);
	assert.throws(() => projects.addFolder(p.id, parse(TMP).root), /demasiado grande/);
	assert.throws(() => projects.addFolder(p.id, process.env.SHIRO_DATA_DIR!), /datos de Aku/);
	projects.addFolder(p.id, FOLDER);
	assert.throws(() => projects.addFolder(p.id, FOLDER), /ya está/);
	assert.equal(projects.getProject(p.id)?.folders.length, 1);
	projects.removeFolder(p.id, FOLDER);
	assert.equal(projects.getProject(p.id)?.folders.length, 0);
});

test("una carpeta que contiene los datos de Shiro se puede vincular, pero los datos quedan ocultos", async () => {
	// Como vincular C:\Users\…\GitHub con Shiro (y su carpeta data) dentro.
	const dataDir = process.env.SHIRO_DATA_DIR!;
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, "secreto.json"), '{"llmApiKey":"sk-no-se-ve"}');
	assert.throws(() => projects.addFolder(projects.createProject({ name: "Dentro" }).id, join(dataDir, "projects")), /datos de Aku/);
	const p = projects.addFolder(projects.createProject({ name: "Padre" }).id, TMP)!;
	const label = projects.projectSources(p)[1]!.label;
	assert.ok(projects.resolveProjectPath(p, `${label}/MiTienda/precios.csv`));
	assert.equal(projects.resolveProjectPath(p, `${label}/data/secreto.json`), null);
	assert.equal(projects.resolveProjectPath(p, join(dataDir, "secreto.json")), null);
	// Lo subido al proyecto vive en la carpeta de datos, pero sigue accesible como Subidos/.
	projects.saveUpload(p.id, "nota.txt", Buffer.from("hola"));
	assert.ok(projects.resolveProjectPath(p, "Subidos/nota.txt"));
	const files = projects.listProjectFiles(p).map((f) => f.path);
	assert.ok(files.includes(`${label}/MiTienda/precios.csv`));
	assert.ok(!files.some((f) => f.startsWith(`${label}/data/`)));
	await projects.runWithProject(p, async () => {
		assert.equal((await executeTool("project", { action: "read", path: `${label}/data/secreto.json` })).ok, false);
		assert.doesNotMatch(out(await executeTool("project", { action: "search", query: "sk-no-se-ve" })), /secreto/);
	});
});

test("las rutas del modelo no se salen del proyecto", () => {
	const p = projects.addFolder(projects.createProject({ name: "Rutas" }).id, FOLDER)!;
	assert.equal(projects.resolveProjectPath(p, "MiTienda/precios.csv")?.full, join(FOLDER, "precios.csv"));
	assert.equal(projects.resolveProjectPath(p, "mitienda\\src\\app.ts")?.path, "MiTienda/src/app.ts");
	assert.equal(projects.resolveProjectPath(p, join(FOLDER, "precios.csv"))?.path, "MiTienda/precios.csv");
	assert.equal(projects.resolveProjectPath(p, "MiTienda/../../secreto.txt"), null);
	assert.equal(projects.resolveProjectPath(p, "Subidos/../../project.json"), null);
	assert.equal(projects.resolveProjectPath(p, "OtraCosa/a.txt"), null);
	assert.equal(projects.resolveProjectPath(p, join(TMP, "fuera.txt")), null);
	assert.equal(projects.cleanUploadPath("../../x.txt"), null);
	assert.equal(projects.cleanUploadPath("informes\\2024/a?.pdf"), "informes/2024/a.pdf");
});

test("subir archivos, listar (sin node_modules) y quitar", () => {
	const p = projects.addFolder(projects.createProject({ name: "Archivos" }).id, FOLDER)!;
	assert.equal(projects.saveUpload(p.id, "notas/ideas.md", Buffer.from("# Ideas\nAbrir los domingos")), "notas/ideas.md");
	assert.throws(() => projects.saveUpload(p.id, "../fuera.txt", Buffer.from("x")), /no válido/);
	const files = projects.listProjectFiles(p).map((f) => f.path);
	assert.ok(files.includes("Subidos/notas/ideas.md"));
	assert.ok(files.includes("MiTienda/precios.csv"));
	assert.ok(files.includes("MiTienda/src/app.ts"));
	assert.ok(!files.some((f) => f.includes("node_modules")));
	assert.deepEqual(projects.listUploadsTop(p.id).map((u) => [u.name, u.kind, u.files]), [["notas", "folder", 1]]);
	assert.match(projects.projectIndex(p), /Subidos\/notas\/ideas\.md/);
	assert.equal(projects.removeUpload(p.id, "notas"), true);
	assert.equal(projects.listUploadsTop(p.id).length, 0);
});

test("chats de un proyecto", () => {
	const a = projects.createProject({ name: "A" });
	const b = projects.createProject({ name: "B" });
	projects.attachChat(a.id, "chat-1");
	assert.equal(projects.projectOfChat("chat-1")?.id, a.id);
	// Un chat solo está en un proyecto: al moverlo sale del anterior.
	projects.attachChat(b.id, "chat-1");
	assert.equal(projects.projectOfChat("chat-1")?.id, b.id);
	assert.deepEqual(projects.getProject(a.id)?.chats, []);
	projects.forgetChat("chat-1");
	assert.equal(projects.projectOfChat("chat-1"), null);
});

test("lee texto, Word y PDF", async () => {
	const dir = join(TMP, "docs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "contrato.docx"), makeDocx("El pago vence el 5 de cada mes"));
	writeFileSync(join(dir, "factura.pdf"), makePdf("Total a pagar 120 euros"));
	writeFileSync(join(dir, "hoja.xlsx"), "no es texto");
	assert.match(await extractText(join(dir, "contrato.docx")), /El pago vence el 5 de cada mes/);
	assert.match(await extractText(join(dir, "factura.pdf")), /Total a pagar 120 euros/);
	await assert.rejects(extractText(join(dir, "hoja.xlsx")), /\.xlsx/);
});

test("tool project: listar, leer, buscar y escribir dentro del proyecto", async () => {
	const p = projects.addFolder(projects.createProject({ name: "Tool", instructions: "Sé breve" }).id, FOLDER)!;
	projects.saveUpload(p.id, "contrato.docx", makeDocx("La renta mensual es de 800 euros"));

	assert.match(out(await executeTool("project", { action: "list" })), /no está en un proyecto/);

	await projects.runWithProject(p, async () => {
		const list = await executeTool("project", { action: "list" });
		assert.ok(list.ok && list.content.includes("Subidos/contrato.docx"));

		const read = await executeTool("project", { action: "read", path: "Subidos/contrato.docx" });
		assert.ok(read.ok && read.content.includes("800 euros"));

		const search = await executeTool("project", { action: "search", query: "Renta mensual" });
		assert.ok(search.ok && search.content.includes("Subidos/contrato.docx:1:"));
		const csv = await executeTool("project", { action: "search", query: "cachapa", path: "MiTienda" });
		assert.ok(csv.ok && csv.content.includes("MiTienda/precios.csv:3:"));

		const outside = await executeTool("project", { action: "read", path: "../../config.json" });
		assert.equal(outside.ok, false);

		const write = await executeTool("project", { action: "write", path: "MiTienda/notas.md", content: "hola" });
		assert.ok(write.ok);
		assert.equal(readFileSync(join(FOLDER, "notas.md"), "utf-8"), "hola");
		const pdf = await executeTool("project", { action: "write", path: "MiTienda/a.pdf", content: "x" });
		assert.match(out(pdf), /texto/);
		assert.ok(!existsSync(join(FOLDER, "a.pdf")));

		// Escribir pide permiso; leer, listar y buscar no.
		assert.match(describeRiskyAction("project", { action: "write", path: "MiTienda/notas.md", content: "hola" }) ?? "", /proyecto «Tool»/);
		assert.equal(describeRiskyAction("project", { action: "read", path: "MiTienda/notas.md" }), null);
	});
	rmSync(join(FOLDER, "notas.md"), { force: true });
});

test("lectura por trozos de archivos largos", async () => {
	const p = projects.createProject({ name: "Largo" });
	projects.saveUpload(p.id, "libro.txt", Buffer.from("a".repeat(30_000)));
	await projects.runWithProject(p, async () => {
		// Una sola línea enorme no cabe: se sigue por letras.
		const first = await executeTool("project", { action: "read", path: "Subidos/libro.txt" });
		assert.match(out(first), /caracteres 0–11700 de 30000/);
		assert.match(out(first), /offset=11700/);
		const second = await executeTool("project", { action: "read", path: "Subidos/libro.txt", offset: 24000 });
		assert.ok(second.ok && !/offset=/.test(second.content.split("\n\n").pop() ?? ""));
	});
});

test("project read: un archivo con líneas se lee por tramos y dice cómo seguir", async () => {
	const p = projects.createProject({ name: "Tramos" });
	const lines = Array.from({ length: 500 }, (_, i) => `línea ${i + 1} ${"x".repeat(60)}`);
	projects.saveUpload(p.id, "codigo.ts", Buffer.from(lines.join("\r\n") + "\r\n"));
	projects.saveUpload(p.id, "corto.md", Buffer.from("uno\ndos\n"));
	await projects.runWithProject(p, async () => {
		const whole = out(await executeTool("project", { action: "read", path: "Subidos/corto.md" }));
		assert.equal(whole, "Archivo: Subidos/corto.md\n\nuno\ndos");
		const first = out(await executeTool("project", { action: "read", path: "Subidos/codigo.ts" }));
		const m = /\(líneas 1–(\d+) de 500\)/.exec(first);
		assert.ok(m, first.slice(0, 80));
		assert.match(first, new RegExp(`Sigue con line=${Number(m[1]) + 1}\\.`));
		assert.ok(first.length <= 12_000);
		const part = out(await executeTool("project", { action: "read", path: "Subidos/codigo.ts", line: 120, lines: 3 }));
		assert.match(part, /\(líneas 120–122 de 500\)/);
		assert.match(part, /línea 120 x+\nlínea 121 x+\nlínea 122 x+\n\n\[…continúa: quedan 378 líneas\. Sigue con line=123\.\]$/);
		const last = out(await executeTool("project", { action: "read", path: "Subidos/codigo.ts", line: 499 }));
		assert.match(last, /\(líneas 499–500 de 500\)/);
		assert.doesNotMatch(last, /continúa/);
		const beyond = await executeTool("project", { action: "read", path: "Subidos/codigo.ts", line: 900 });
		assert.ok(!beyond.ok && /solo tiene 500 líneas/.test(beyond.error ?? ""));
	});
});

test("project find: encuentra archivos por nombre o patrón", async () => {
	const p = projects.createProject({ name: "Nombres" });
	for (const f of ["src/api/usuarios.ts", "src/api/usuarios.test.ts", "src/web/login.tsx", "docs/Guía de API.md", "README.md"]) {
		projects.saveUpload(p.id, f, Buffer.from("x"));
	}
	await projects.runWithProject(p, async () => {
		const tests = out(await executeTool("project", { action: "find", query: "*.test.ts" }));
		assert.match(tests, /Subidos\/src\/api\/usuarios\.test\.ts/);
		assert.doesNotMatch(tests, /usuarios\.ts \(/);
		// Sin comodines: todas las palabras en la ruta, sin tildes ni mayúsculas.
		const guia = out(await executeTool("project", { action: "find", query: "guia api" }));
		assert.match(guia, /Guía de API\.md/);
		// Con carpetas: `*` no las cruza, `**` sí; con o sin el nombre de la carpeta del proyecto.
		assert.match(out(await executeTool("project", { action: "find", query: "src/**/*.ts" })), /usuarios\.ts/);
		assert.match(out(await executeTool("project", { action: "find", query: "Subidos/src/*/login.tsx" })), /login\.tsx/);
		assert.match(out(await executeTool("project", { action: "find", query: "src/*.ts" })), /No hay archivos/);
		assert.match(out(await executeTool("project", { action: "find", query: "nada-de-nada" })), /No hay archivos/);
		assert.ok(!(await executeTool("project", { action: "find" })).ok);
	});
	assert.equal(projects.globToRegExp("a.b").test("axb"), false);
});

test("project search: filtro de archivos, líneas de alrededor y reparto entre archivos", async () => {
	const p = projects.createProject({ name: "Busca" });
	projects.saveUpload(p.id, "a.ts", Buffer.from(["// cabecera", "function sumar(a, b) {", "  return a + b;", "}", ...Array.from({ length: 9 }, (_, i) => `sumar(${i}, 1);`)].join("\n")));
	projects.saveUpload(p.id, "b.md", Buffer.from("Para sumar usa la función.\n"));
	await projects.runWithProject(p, async () => {
		const all = out(await executeTool("project", { action: "search", query: "sumar" }));
		assert.match(all, /^11 coincidencias en 2 archivos:/);
		// Como mucho 5 líneas por archivo, y avisa de las que no enseña.
		assert.equal((all.match(/Subidos\/a\.ts:\d+:/g) ?? []).length, 5);
		assert.match(all, /Subidos\/a\.ts: \(\+5 coincidencias más en este archivo\)/);
		assert.match(all, /Subidos\/b\.md:1: Para sumar/);
		const onlyMd = out(await executeTool("project", { action: "search", query: "sumar", files: "*.md" }));
		assert.match(onlyMd, /^1 coincidencia en 1 archivo:/);
		assert.doesNotMatch(onlyMd, /a\.ts/);
		const ctx = out(await executeTool("project", { action: "search", query: "function sumar", context: 1 }));
		assert.match(ctx, /Subidos\/a\.ts:2: function sumar\(a, b\) \{\n {4}1\| \/\/ cabecera\n {4}3\| {3}return a \+ b;/);
		assert.match(out(await executeTool("project", { action: "search", query: "no-existe" })), /No encontré/);
		// Como lo escriben los modelos por costumbre: «|» separa alternativas y «.*» vale por «y».
		assert.match(out(await executeTool("project", { action: "search", query: "no-existe|cabecera" })), /^1 coincidencia en 1 archivo:\nSubidos\/a\.ts:1: \/\/ cabecera/);
		assert.match(out(await executeTool("project", { action: "search", query: "function.*sumar" })), /Subidos\/a\.ts:2: function sumar/);
	});
});

test("project edit: cambia un trozo, conserva los saltos de línea y explica los fallos", async () => {
	const { writeFileSync: write, readFileSync: read, mkdirSync: mkdir } = await import("node:fs");
	const dir = join(TMP, "editar");
	mkdir(dir, { recursive: true });
	const file = join(dir, "app.ts");
	write(file, "const a = 1;\r\nconst b = 2;   \r\nconst c = 3;\r\nconst b2 = 2;\r\n");
	const created = projects.createProject({ name: "Editar" });
	const p = projects.addFolder(created.id, dir)!;
	await projects.runWithProject(p, async () => {
		const edit = (args: Record<string, unknown>) => executeTool("project", { action: "edit", path: "editar/app.ts", ...args });
		const ok = await edit({ old_text: "const a = 1;", new_text: "const a = 10;\nconst extra = true;" });
		assert.match(out(ok), /Cambiado editar\/app\.ts \(línea 1\): 1 línea → 2\./);
		assert.equal(read(file, "utf-8"), "const a = 10;\r\nconst extra = true;\r\nconst b = 2;   \r\nconst c = 3;\r\nconst b2 = 2;\r\n");
		// Los espacios del final de línea que el modelo pierde no impiden encontrar el trozo.
		assert.ok((await edit({ old_text: "const b = 2;\nconst c = 3;", new_text: "const b = 20;\nconst c = 30;" })).ok);
		assert.match(read(file, "utf-8"), /const b = 20;\r\nconst c = 30;\r\n/);
		// Repetido: hay que desambiguar o pedir todas.
		const twice = await edit({ old_text: "= 2", new_text: "= 5" });
		assert.ok(!twice.ok && /aparece 2 veces/.test(twice.error ?? ""), out(twice));
		assert.match(out(await edit({ old_text: "= 2", new_text: "= 5", replace_all: true })), /2 veces/);
		assert.match(read(file, "utf-8"), /const b = 50;[\s\S]*const b2 = 5;/);
		// No está: dice dónde mirar.
		const missing = await edit({ old_text: "const c = 30;\nconst zzz = 0;", new_text: "x" });
		assert.ok(!missing.ok && /No encontré ese texto/.test(missing.error ?? "") && /línea 4/.test(missing.error ?? ""), out(missing));
		assert.ok(!(await edit({ old_text: "const c = 30;", new_text: "const c = 30;" })).ok);
		assert.ok(!(await executeTool("project", { action: "edit", path: "editar/no.ts", old_text: "a", new_text: "b" })).ok);
		assert.ok(!(await executeTool("project", { action: "edit", path: "editar/../../fuera.ts", old_text: "a", new_text: "b" })).ok);
		assert.ok(!(await executeTool("project", { action: "edit", path: "editar/app.ts", new_text: "b" })).ok);
	});
});

test("el system prompt incluye el proyecto con sus instrucciones", async () => {
	const p = projects.createProject({ name: "Viaje", description: "A Japón", instructions: "Presupuesto máximo 2000 euros." });
	projects.saveUpload(p.id, "itinerario.md", Buffer.from("Día 1: Tokio"));
	const inline = await projects.inlineProjectText(p);
	assert.match(inline ?? "", /Día 1: Tokio/);
	const { system } = buildContext({
		goal: "¿Qué hago el primer día?",
		agentName: "Shiro",
		tokenBudget: 8000,
		project: { name: p.name, description: p.description, instructions: p.instructions, index: projects.projectIndex(p), inline, hasTool: true },
	});
	assert.match(system, /## Proyecto «Viaje»/);
	assert.match(system, /Presupuesto máximo 2000 euros/);
	assert.match(system, /Subidos\/itinerario\.md/);
	assert.match(system, /Día 1: Tokio/);
	assert.match(system, /tool project/);
});

test("carpeta del modo Code: reutiliza el proyecto que ya la tiene o crea uno con su nombre", () => {
	const dir = join(TMP, "mi-app");
	mkdirSync(dir, { recursive: true });
	const first = projects.projectForFolder(dir);
	assert.equal(first.name, "mi-app");
	assert.equal(first.folders.length, 1);
	// La misma carpeta (escrita con otra barra al final) da el mismo proyecto, sin duplicarlo.
	assert.equal(projects.projectForFolder(dir + "\\").id, first.id);
	assert.equal(projects.listProjects().filter((p) => p.name === "mi-app").length, 1);
	assert.throws(() => projects.projectForFolder(join(TMP, "no-existe")), /No encuentro la carpeta/);
	assert.throws(() => projects.projectForFolder(parse(TMP).root), /demasiado grande/);
	const recent = projects.recentFolders();
	assert.ok(recent.some((f) => f.projectId === first.id && f.name === "mi-app" && f.exists));
	assert.equal(new Set(recent.map((f) => f.path.toLowerCase())).size, recent.length);
});

test("el modelo sabe en qué carpetas del equipo está el proyecto (para la terminal)", () => {
	const { system } = buildContext({
		goal: "Corre las pruebas",
		agentName: "Shiro",
		tokenBudget: 8000,
		project: { name: "mi-app", index: "(vacío)", hasTool: true, folders: [{ path: "/srv/mi-app" }] },
	});
	assert.ok(system.includes("### Carpetas en este equipo\n- /srv/mi-app\n"));
	assert.match(system, /entra en la que toque con su ruta completa/);
});
