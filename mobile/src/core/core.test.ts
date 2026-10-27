/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn, toOllamaHistory } from "./agent";
import { readLines } from "./ollama";
import { buildSystemPrompt, profileBlock } from "./prompt";
import { addMemory, getNotes, listChats, renameChat, saveChat, saveNote, searchMemories } from "./supabase";
import { buildContent, replaceText, splitContent } from "./content";
import { completeReminder, createReminder, listReminders, parseWhen } from "./reminders";
import { helpText, matchCommands, parseCommand } from "./commands";
import { parseTable, tokenize } from "./highlight";
import { parseProfileNote, profileToMarkdown } from "./prompt";
import { chatTitle, keywords } from "./text";
import type { FetchFn } from "./types";

type Row = Record<string, unknown>;

/** Imita lo que usa la app de PostgREST (Supabase): select, eq/in, order, limit y upsert. */
function fakeSupabase() {
	const tables: Record<string, Row[]> = { shiro_chats: [], shiro_memories: [], shiro_notes: [], shiro_reminders: [] };
	const keys: Record<string, string> = { shiro_chats: "id", shiro_memories: "id", shiro_notes: "path", shiro_reminders: "id" };
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		assert.equal(new Headers(init?.headers).get("apikey"), "sb_secret_x");
		const table = url.pathname.replace(/^\/rest\/v1\//, "");
		const filters: ((r: Row) => boolean)[] = [];
		for (const [k, v] of url.searchParams) {
			if (v.startsWith("eq.")) filters.push((r) => String(r[k]) === v.slice(3));
			if (v.startsWith("in.(")) {
				const list = v.slice(4, -1).split(",").map((s) => JSON.parse(s));
				filters.push((r) => list.includes(String(r[k])));
			}
		}
		const match = (r: Row) => filters.every((f) => f(r));
		if (method === "GET") {
			let rows = tables[table].filter(match);
			const order = url.searchParams.get("order");
			if (order) {
				const [col, dir] = order.split(".");
				rows = [...rows].sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === "desc" ? -1 : 1));
			}
			return new Response(JSON.stringify(rows));
		}
		if (method === "POST") {
			const body = JSON.parse(String(init?.body));
			for (const row of Array.isArray(body) ? body : [body]) {
				const i = tables[table].findIndex((r) => r[keys[table]] === row[keys[table]]);
				if (i >= 0) tables[table][i] = { ...tables[table][i], ...row };
				else tables[table].push(row);
			}
			return new Response("");
		}
		if (method === "PATCH") {
			const body = JSON.parse(String(init?.body));
			for (const r of tables[table].filter(match)) Object.assign(r, body);
			return new Response("");
		}
		tables[table] = tables[table].filter((r) => !match(r));
		return new Response("");
	}) as FetchFn;
	return { tables, conn: { url: "https://demo.supabase.co/", key: "sb_secret_x", fetch: fetchImpl } };
}

/** Ollama Cloud falso: responde lo que diga `script` en cada vuelta (como líneas JSON). */
function fakeOllama(script: ((body: Row) => Row[])[], extra: Record<string, Row> = {}) {
	const bodies: Row[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://ollama.com");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ok-key");
		const body = JSON.parse(String(init?.body ?? "{}")) as Row;
		if (url.pathname !== "/api/chat") return new Response(JSON.stringify(extra[url.pathname] ?? {}));
		bodies.push(body);
		const chunks = script[bodies.length - 1](body);
		return new Response(chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
	}) as FetchFn;
	return { bodies, conn: { key: "ok-key", fetch: fetchImpl } };
}

test("chats con el mismo formato que el PC: título, vista previa y orden", async () => {
	const sb = fakeSupabase();
	const a = await saveChat(sb.conn, {}, [{ role: "user", content: "Hola desde el teléfono, ¿qué tal todo por allá?" }]);
	assert.equal(a.title, "Hola desde el teléfono, ¿qué tal todo po...");
	const row = sb.tables.shiro_chats[0];
	assert.equal(typeof row.created_at, "number");
	assert.ok(Array.isArray(row.messages));
	await new Promise((r) => setTimeout(r, 2));
	await saveChat(sb.conn, {}, [{ role: "user", content: "Otro" }]);
	assert.deepEqual((await listChats(sb.conn)).map((c) => c.title), ["Otro", a.title]);
	assert.equal(chatTitle([]), "Nueva sesión");
});

test("recuerdos: se guardan como en el PC, los importantes van a MEMORY.md y se encuentran por palabras", async () => {
	const sb = fakeSupabase();
	await addMemory(sb.conn, { content: "Le encanta el café de Colombia", important: true });
	await addMemory(sb.conn, { content: "Trabaja de noche" });
	assert.match(String(sb.tables.shiro_memories[0].id), /^mem_/);
	assert.match(String(sb.tables.shiro_notes[0].content), /# MEMORY\.md[\s\S]*- Le encanta el café de Colombia _\(\d{4}-\d\d-\d\d\)_/);
	assert.deepEqual((await searchMemories(sb.conn, "¿qué cafe le gusta?")).map((m) => m.content), ["Le encanta el café de Colombia"]);
	assert.deepEqual(keywords("de la Cafeína"), ["cafeina"]);
	// Otra vez lo mismo: MEMORY.md no se repite.
	await addMemory(sb.conn, { content: "Le encanta el café de Colombia", important: true });
	assert.equal(String(sb.tables.shiro_notes[0].content).match(/café de Colombia/g)?.length, 1);
});

test("el prompt usa las notas del PC: instrucciones, nombre, «Sobre mí», SOUL y MEMORY", async () => {
	const sb = fakeSupabase();
	sb.tables.shiro_notes.push(
		{ path: "Instrucciones.md", content: "Eres {{nombre}}. Hablas con {{usuario}}. Hoy: {{fecha}}", updated_at: 1 },
		{ path: "Sobre mí.md", content: '---\nnombre: "Jhon"\nidioma: "español"\n---\n# Sobre mí\n\n## Qué debería saber Shiro de ti\nProgramador junior\n\n## Notas\n\n', updated_at: 1 },
		{ path: "SOUL.md", content: "Eres curioso.", updated_at: 1 },
		{ path: "MEMORY.md", content: "- Tiene un gato", updated_at: 1 },
		{ path: "_shiro.json", content: '{"assistantName":"Aku"}', updated_at: 1 },
		{ path: "TOOLS.md", content: "no se pide", updated_at: 1 },
	);
	const notes = await getNotes(sb.conn);
	assert.doesNotMatch(buildSystemPrompt(notes), /no se pide/, "TOOLS.md habla de herramientas del PC: no va al prompt del móvil");
	const system = buildSystemPrompt(notes, { now: new Date(2026, 9, 26) });
	assert.match(system, /^Eres Aku\. Hablas con Jhon\. Hoy: /);
	assert.match(system, /app del móvil/);
	assert.match(system, /Nombre: Jhon\nIdioma preferido: español\nQué debería saber Shiro de ti: Programador junior/);
	assert.doesNotMatch(system, /Notas:/, "las secciones vacías no se mandan");
	assert.match(system, /Eres curioso\.[\s\S]*Tiene un gato/);
	assert.match(buildSystemPrompt(notes, { assistantName: "Miku" }), /^Eres Miku\./);
	assert.match(buildSystemPrompt({}), /^Eres Shiro/);
	assert.deepEqual(profileBlock(undefined), { userName: "", text: "" });
});

test("una respuesta con herramientas: busca en la memoria y luego contesta en vivo", async () => {
	const sb = fakeSupabase();
	await addMemory(sb.conn, { content: "Su perro se llama Toby" });
	const ollama = fakeOllama([
		(body) => {
			assert.equal((body.tools as unknown[]).length, 7);
			return [{ message: { content: "", tool_calls: [{ function: { name: "memory_search", arguments: { query: "perro" } } }] } }, { done: true }];
		},
		(body) => {
			const msgs = body.messages as Row[];
			assert.equal(msgs.at(-1)?.role, "tool");
			assert.match(String(msgs.at(-1)?.content), /Toby/);
			return [{ message: { content: "Se llama " } }, { message: { content: "Toby." } }, { done: true }];
		},
	]);
	const deltas: string[] = [];
	const labels: string[] = [];
	const r = await runAgentTurn(
		{ sb: sb.conn, ollama: ollama.conn, model: "gpt-oss:120b", system: "sys" },
		[{ role: "user", content: "¿Cómo se llama mi perro?" }],
		{ onDelta: (d) => deltas.push(d), onTool: (l, done) => done && labels.push(l) },
	);
	assert.equal(r.text, "Se llama Toby.");
	assert.deepEqual(r.tools, [{ name: "memory_search", label: "Buscando en tu memoria: perro", ok: true }]);
	assert.deepEqual(labels, ["Buscando en tu memoria: perro"]);
	assert.equal(deltas.join(""), "Se llama Toby.");
	assert.equal((ollama.bodies[0].messages as Row[])[0].role, "system");
});

test("búsqueda web de Ollama, errores de herramientas y límite de pasos", async () => {
	const sb = fakeSupabase();
	const call = (name: string, args: Row) => () => [{ message: { content: "", tool_calls: [{ function: { name, arguments: args } }] } }];
	const ollama = fakeOllama(
		[call("search_web", { query: "clima" }), call("fetch_url", { url: "ftp://x" }), call("search_web", { query: "otra" }), () => [{ message: { content: "Listo" } }]],
		{ "/api/web_search": { results: [{ title: "Clima", url: "https://clima.cl", content: "Soleado" }] } },
	);
	const r = await runAgentTurn({ sb: sb.conn, ollama: ollama.conn, model: "m", system: "s", maxSteps: 4 }, [{ role: "user", content: "clima" }]);
	assert.equal(r.text, "Listo");
	assert.deepEqual(r.tools.map((t) => t.name), ["search_web", "fetch_url", "search_web"]);
	assert.match(String((ollama.bodies[1].messages as Row[]).at(-1)?.content), /Soleado/);
	assert.match(String((ollama.bodies[2].messages as Row[]).at(-1)?.content), /http:\/\/ o https:\/\//);
	assert.equal(ollama.bodies[3].tools, undefined, "en la última vuelta no hay herramientas");
});

test("lee líneas aunque lleguen partidas y recorta el historial largo", async () => {
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		start(c) {
			c.enqueue(enc.encode('{"a":'));
			c.enqueue(enc.encode('1}\n{"b":2}\n{"c"'));
			c.enqueue(enc.encode(":3}"));
			c.close();
		},
	});
	const lines: string[] = [];
	for await (const l of readLines(new Response(stream))) lines.push(l);
	assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);

	const long = Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `${i} ${"x".repeat(1000)}` }));
	const h = toOllamaHistory(long, 10_000);
	assert.ok(h.length < 12 && h.at(-1)?.content.startsWith("49 "));
});

test("fechas de recordatorios: ISO, relativas y «mañana a las 9»", () => {
	const now = new Date(2026, 9, 27, 10, 0, 0);
	assert.equal(parseWhen("in 30 minutes", now), new Date(2026, 9, 27, 10, 30).toISOString());
	assert.equal(parseWhen("en 2 horas", now), new Date(2026, 9, 27, 12, 0).toISOString());
	assert.equal(parseWhen("mañana a las 9", now), new Date(2026, 9, 28, 9, 0).toISOString());
	assert.equal(parseWhen("a las 9", now), new Date(2026, 9, 28, 9, 0).toISOString(), "las 9 ya pasaron: mañana");
	assert.equal(parseWhen("21:30", now), new Date(2026, 9, 27, 21, 30).toISOString());
	assert.equal(parseWhen("hoy a las 6pm", now), new Date(2026, 9, 27, 18, 0).toISOString());
	assert.equal(parseWhen("2026-12-24T20:00:00.000Z", now), "2026-12-24T20:00:00.000Z");
	assert.equal(parseWhen("cuando pueda", now), null);
	assert.equal(parseWhen("9", now), null);
});

test("recordatorios en Supabase con el formato del PC; los que se repiten crean el siguiente", async () => {
	const sb = fakeSupabase();
	const now = new Date(2026, 9, 27, 10, 0);
	const r = await createReminder(sb.conn, { title: "Tomar agua", datetime: "en 1 hora", repeat: "daily" }, now);
	assert.match(r.id, /^rem_/);
	assert.deepEqual(sb.tables.shiro_reminders[0].data, JSON.parse(JSON.stringify(r)));
	await assert.rejects(createReminder(sb.conn, { title: "x", datetime: "algún día" }), /No entiendo la fecha/);
	await completeReminder(sb.conn, r.id);
	const all = await listReminders(sb.conn);
	assert.equal(all.length, 2);
	assert.ok(all.find((x) => x.id === r.id)?.completed);
	const next = all.find((x) => x.id !== r.id)!;
	assert.equal(next.datetime, new Date(2026, 9, 28, 11, 0).toISOString());
	assert.ok(next.active && !next.completed);
});

test("adjuntos con el formato de la web: archivos en el texto e imágenes como partes", () => {
	const c = buildContent("Mira esto", [
		{ kind: "file", name: "notas.txt", text: "hola" },
		{ kind: "image", name: "foto.jpg", dataUrl: "data:image/jpeg;base64,QUJD" },
	]);
	assert.ok(Array.isArray(c));
	assert.match(JSON.stringify(c), /<<<archivo: notas.txt>>>\\nhola\\n<<<fin del archivo>>>/);
	assert.deepEqual(splitContent(c), { text: "Mira esto", files: ["notas.txt"], images: ["data:image/jpeg;base64,QUJD"] });
	const edited = replaceText(c, "Otra cosa");
	assert.deepEqual(splitContent(edited), { text: "Otra cosa", files: ["notas.txt"], images: ["data:image/jpeg;base64,QUJD"] });
	assert.equal(buildContent("solo texto", []), "solo texto");
	const h = toOllamaHistory([{ role: "user", content: c }]);
	assert.deepEqual((h[0] as { images?: string[] }).images, ["QUJD"]);
});

test("comandos, colores del código y tablas", () => {
	assert.deepEqual(matchCommands("/rec").map((c) => c.name), ["recordatorios"]);
	assert.deepEqual(matchCommands("hola"), []);
	assert.deepEqual(parseCommand("/model qwen3"), { command: "modelo", arg: "qwen3" });
	assert.equal(parseCommand("/nada"), null);
	assert.match(helpText(), /\/recordatorios/);
	const toks = tokenize('const x = "hola"; // saludo\nreturn 42', "js");
	assert.deepEqual(toks.filter((t) => t.kind !== "plain").map((t) => [t.kind, t.text]), [
		["keyword", "const"], ["string", '"hola"'], ["comment", "// saludo"], ["keyword", "return"], ["number", "42"],
	]);
	assert.equal(tokenize("# título", "md")[0].kind, "plain", "en Markdown # no es comentario");
	assert.deepEqual(parseTable(["| a | b |", "|---|---|", "| 1 | 2 |"]), { head: ["a", "b"], rows: [["1", "2"]] });
	assert.equal(parseTable(["| a | b |", "| 1 | 2 |"]), null);
});

test("Personalización: «Sobre ti» con el formato del PC, notas y renombrar chats", async () => {
	const md = profileToMarkdown({ userName: "Jhon", language: "español", about: "Programador junior", extra: "Corto y claro" });
	assert.match(md, /^---\nnombre: "Jhon"\nidioma: "español"\n---\n# Sobre mí\n\n## Qué debería saber de mí\nProgramador junior\n\n## Cómo quiero que respondas\nCorto y claro/);
	assert.deepEqual(parseProfileNote(md), { userName: "Jhon", language: "español", about: "Programador junior", extra: "Corto y claro" });
	const sb = fakeSupabase();
	await saveNote(sb.conn, "SOUL.md", "Eres curioso.\r\n");
	assert.equal(sb.tables.shiro_notes[0].content, "Eres curioso.\n");
	const meta = await saveChat(sb.conn, {}, [{ role: "user", content: "Hola" }]);
	await renameChat(sb.conn, meta.id, "  Charla   nueva ");
	assert.equal((await listChats(sb.conn))[0].title, "Charla nueva");
	await assert.rejects(renameChat(sb.conn, meta.id, "  "), /vacío/);
});
