import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Todo en una carpeta temporal: SHIRO_DATA_DIR tiene que estar puesto antes de cargar config.ts.
const TMP = mkdtempSync(join(tmpdir(), "shiro-storage-"));
process.env.SHIRO_DATA_DIR = join(TMP, "data");
const VAULT = join(TMP, "Boveda");
after(() => rmSync(TMP, { recursive: true, force: true }));
mkdirSync(join(VAULT, ".obsidian"), { recursive: true });
writeFileSync(join(VAULT, "Recetas.md"), "# Recetas\n\nLa arepa reina pepiada lleva aguacate y pollo.\n");

const { setConfig, getConfig, DATA_DIR } = await import("../config/config.js");
const chats = await import("../chat/ChatStore.js");
const memories = await import("../core/memory/memories.js");
const reminders = await import("../core/reminders/reminders.js");
const obsidian = await import("./obsidian.js");
const { getWorkspaceDir, ensureWorkspace, buildMemoryGuide, backupDirFor, backupVault, LOCAL_WORKSPACE_DIR } = await import("../workspace.js");
const { rebuildStructure } = await import("./rebuild.js");
const { migrateStorage } = await import("./migrate.js");
const supabase = await import("./supabase.js");
const { testStorage } = await import("./storage.js");
const { parseStorage } = await import("../storageApi.js");

// Sin servidor de embeddings: la búsqueda tiene que funcionar solo con palabras clave.
setConfig({ embeddingsBaseUrl: "http://127.0.0.1:9" });

const LOCAL = { kind: "local" as const };
const OBSIDIAN = { kind: "obsidian" as const, obsidianVault: VAULT };

test("usa la carpeta de datos de SHIRO_DATA_DIR", () => {
	assert.equal(DATA_DIR, join(TMP, "data"));
	assert.equal(getWorkspaceDir(), LOCAL_WORKSPACE_DIR);
});

test("nombres de archivo y encabezados de notas", () => {
	assert.equal(obsidian.safeFileName('¿Qué es "esto"? / a:b'), "¿Qué es esto a b");
	assert.equal(obsidian.safeFileName("   "), "Sin título");
	const { meta, body } = obsidian.parseFrontmatter("---\r\nid: x\r\ntipo: decision\r\n---\r\nHola");
	assert.deepEqual(meta, { id: "x", tipo: "decision" });
	assert.equal(body, "Hola");
	const md = obsidian.chatToMarkdown(
		{ id: "c1", title: "Sala", createdAt: 0, updatedAt: 0, messages: [{ role: "assistant", content: "Hola", agentName: "Viernes" }] },
		{ user: "Tú", assistant: "Aku" },
	);
	assert.match(md, /\*\*\[\[Agentes\/Viernes\|Viernes\]\]\*\*/, "en una sala, el nombre enlaza a la nota del agente");
});

test("encuentra las bóvedas que conoce la app de Obsidian", () => {
	const file = join(TMP, "obsidian.json");
	writeFileSync(file, JSON.stringify({ vaults: { a: { path: VAULT, ts: 2 }, b: { path: join(TMP, "no-existe"), ts: 3 } } }));
	assert.deepEqual(obsidian.listObsidianVaults(file), [{ path: VAULT, name: "Boveda" }]);
	assert.deepEqual(obsidian.listObsidianVaults(join(TMP, "falta.json")), []);
});

test("comprueba la bóveda antes de usarla", async () => {
	assert.deepEqual(await testStorage(OBSIDIAN), { ok: true });
	const r = await testStorage({ kind: "obsidian", obsidianVault: join(TMP, "no-existe") });
	assert.equal(r.ok, false);
	const plain = join(TMP, "carpeta");
	mkdirSync(plain);
	const w = await testStorage({ kind: "obsidian", obsidianVault: plain });
	assert.ok(w.ok && w.warning?.includes(".obsidian"));
});

test("chats en este equipo: crear, guardar, renombrar, enlazar y borrar", async () => {
	setConfig({ storage: "local" });
	const c = await chats.createChatSession([{ role: "user", content: "Hola Shiro" }]);
	assert.equal(c.title, "Hola Shiro");
	const saved = await chats.saveChatSession(c.id, [
		{ role: "user", content: "Hola Shiro" },
		{ role: "assistant", content: "¡Hola!" },
	]);
	assert.equal(saved?.lastPreview, "¡Hola!");
	assert.equal((await chats.getChatSession(c.id))?.messages.length, 2);
	assert.equal((await chats.renameChatSession(c.id, "Saludo"))?.title, "Saludo");
	assert.ok((await chats.listChatSessions()).some((s) => s.id === c.id));

	const linked = await chats.getOrCreateLinkedChatSession("telegram", "42", "Chat de Telegram");
	assert.equal((await chats.getOrCreateLinkedChatSession("telegram", "42")).id, linked.id);
	assert.equal((await chats.getChatSession(linked.id))?.title, "Chat de Telegram");

	assert.equal(await chats.saveChatSession("no-existe", []), null);
	assert.equal(await chats.deleteChatSession(linked.id), true);
	assert.equal(await chats.getChatSession(linked.id), null);
});

test("recuerdos en este equipo: se guardan de verdad y se encuentran por palabras", async () => {
	setConfig({ storage: "local" });
	await memories.addMemory({ content: "Ghambitho es cocinero y le gusta el pabellón criollo", tags: ["comida"] });
	await memories.addMemory({ content: "Prefiere respuestas cortas" });
	const hits = await memories.searchMemories("¿qué comida le gusta cocinar? pabellon", 5);
	assert.equal(hits[0]?.content, "Ghambitho es cocinero y le gusta el pabellón criollo");
	assert.equal((await memories.listMemories()).length, 2);
	assert.deepEqual(await memories.searchMemories("astronomía", 5), []);
});

test("recordatorios: crear, completar (con repetición) y borrar", async () => {
	setConfig({ storage: "local" });
	const r = await reminders.createReminder({ title: "Tomar agua", datetime: "2020-01-01T10:00:00.000Z", repeat: "daily" });
	assert.ok((await reminders.getDueReminders()).some((x) => x.id === r.id));
	await reminders.completeReminder(r.id);
	const next = (await reminders.getActiveReminders()).find((x) => x.title === "Tomar agua");
	assert.equal(next?.datetime, "2020-01-02T10:00:00.000Z");
	assert.equal(await reminders.deleteReminder(next!.id), true);
});

test("pasar a Obsidian lleva chats, recuerdos, recordatorios y notas de memoria", async () => {
	setConfig({ storage: "local" });
	ensureWorkspace();
	await reminders.createReminder({ title: "Llamar a mamá", datetime: "2030-05-01T18:00:00.000Z" });
	const result = await migrateStorage(LOCAL, OBSIDIAN);
	setConfig({ storage: "obsidian", obsidianVault: VAULT });

	const root = join(VAULT, "Shiro");
	assert.equal(getWorkspaceDir(), root);
	assert.ok(existsSync(join(root, "SOUL.md")), "SOUL.md en la bóveda");
	assert.ok(!existsSync(join(root, "skills")), "las habilidades se quedan en el equipo");
	assert.ok(result.chats >= 1 && result.memories === 2);
	assert.ok(readdirSync(join(root, "Chats")).some((f) => f.includes("Saludo")));
	assert.equal(readdirSync(join(root, "Recuerdos")).length, 2);
	assert.match(readFileSync(join(root, "Recordatorios.md"), "utf-8"), /Llamar a mamá/);
});

test("con Obsidian, cada chat tiene su nota y la búsqueda mira solo la carpeta Shiro", async () => {
	setConfig({ storage: "obsidian", obsidianVault: VAULT });
	const c = await chats.createChatSession([{ role: "user", content: "Receta de cachapas" }]);
	const notes = () => readdirSync(join(VAULT, "Shiro", "Chats")).filter((f) => f.includes(c.id.slice(0, 8)));
	assert.equal(notes().length, 1);
	await chats.renameChatSession(c.id, "Cachapas");
	assert.deepEqual(
		notes().map((f) => f.replace(/^\d{4}-\d{2}-\d{2} /, "")),
		[`Cachapas (${c.id.slice(0, 8)}).md`],
	);
	await chats.deleteChatSession(c.id);
	assert.equal(notes().length, 0);

	const m = await memories.addMemory({ content: "Su color favorito es el verde", type: "decision" });
	assert.equal(m.embedding, undefined);
	const found = await memories.searchMemories("color favorito", 3);
	assert.equal(found[0]?.content, "Su color favorito es el verde");
	assert.match(found[0]?.source ?? "", /^Recuerdos[\\/]/, "ruta que entiende read_file");

	// Recetas.md está fuera de la carpeta Shiro: no es memoria de Shiro.
	assert.deepEqual(await memories.searchMemories("arepa pepiada", 3), []);
	mkdirSync(join(VAULT, "Shiro", "Notas"), { recursive: true });
	writeFileSync(join(VAULT, "Shiro", "Notas", "Cachapas.md"), "# Cachapas\n\nLas cachapas llevan queso de mano.\n");
	const inside = await memories.searchMemories("cachapas queso", 3);
	assert.equal(inside[0]?.source, join("Notas", "Cachapas.md"));
	assert.match(inside[0]?.content ?? "", /queso de mano/);
});

test("los recuerdos importantes también van a MEMORY.md, sin repetirse", async () => {
	setConfig({ storage: "obsidian", obsidianVault: VAULT });
	ensureWorkspace();
	const file = join(VAULT, "Shiro", "MEMORY.md");
	await memories.addMemory({ content: "Se llama Ghambitho y\nestudia ciberseguridad", important: true });
	await memories.addMemory({ content: "Se llama Ghambitho y estudia ciberseguridad", important: true });
	await memories.addMemory({ content: "Hoy almorzó arepas" });
	const text = readFileSync(file, "utf-8");
	assert.equal(text.match(/estudia ciberseguridad/g)?.length, 1);
	assert.match(text, /^- Se llama Ghambitho y estudia ciberseguridad _\(\d{4}-\d{2}-\d{2}\)_$/m);
	assert.doesNotMatch(text, /arepas/);
});

test("el modelo sabe dónde está su memoria", () => {
	const obs = buildMemoryGuide(OBSIDIAN);
	assert.match(obs, /Obsidian/);
	assert.match(obs, /«Boveda»/);
	assert.match(obs, /SON tu memoria/);
	assert.match(obs, /Recuerdos\//);
	assert.match(buildMemoryGuide({ kind: "obsidian", obsidianVault: join(TMP, "no-existe") }), /no la encuentro/);
	assert.match(buildMemoryGuide(LOCAL), /en este equipo/);
	assert.match(buildMemoryGuide({ kind: "supabase" }), /Supabase/);
	for (const s of [OBSIDIAN, LOCAL]) assert.match(buildMemoryGuide(s), /memory_add/);
});

test("al cambiar de sitio no se pisa un MEMORY.md que ya tiene cosas", async () => {
	const other = join(TMP, "Otra");
	mkdirSync(join(other, "Shiro"), { recursive: true });
	writeFileSync(join(other, "Shiro", "MEMORY.md"), "# MEMORY.md\n\n- Vive en Caracas\n");
	writeFileSync(join(other, "Shiro", "SOUL.md"), "# Soy Aku\n");
	await migrateStorage(OBSIDIAN, { kind: "obsidian", obsidianVault: other });
	const memory = readFileSync(join(other, "Shiro", "MEMORY.md"), "utf-8");
	assert.match(memory, /Vive en Caracas/);
	assert.match(memory, /estudia ciberseguridad/);
	assert.equal(memory.match(/Vive en Caracas/g)?.length, 1);
	assert.equal(readFileSync(join(other, "Shiro", "SOUL.md"), "utf-8"), "# Soy Aku\n", "SOUL.md cambiado se respeta");
	await migrateStorage(OBSIDIAN, { kind: "obsidian", obsidianVault: other });
	assert.equal(readFileSync(join(other, "Shiro", "MEMORY.md"), "utf-8"), memory, "repetir no duplica");
});

test("volver a este equipo trae las notas de la bóveda", async () => {
	writeFileSync(join(VAULT, "Shiro", "MEMORY.md"), "# MEMORY.md\n\nEditado en Obsidian\n");
	await migrateStorage(OBSIDIAN, LOCAL);
	setConfig({ storage: "local" });
	assert.match(readFileSync(join(LOCAL_WORKSPACE_DIR, "MEMORY.md"), "utf-8"), /Editado en Obsidian/);
	assert.ok(!existsSync(join(LOCAL_WORKSPACE_DIR, "Chats")), "las copias de chats no se traen");
	assert.ok((await memories.listMemories()).some((m) => m.content === "Su color favorito es el verde"));
});

test("al guardar solo se usan los campos de la opción elegida", () => {
	setConfig({ storage: "local", obsidianVault: undefined, supabaseUrl: undefined, supabaseKey: undefined });
	const local = parseStorage({ kind: "local", supabaseUrl: "https://a.supabase.co", supabaseKey: "sb_secret_x", obsidianVault: VAULT });
	assert.deepEqual([local?.kind, local?.supabaseUrl, local?.supabaseKey, local?.obsidianVault], ["local", undefined, undefined, undefined]);
	const sb = parseStorage({ kind: "supabase", supabaseUrl: "https://a.supabase.co/rest/v1/", supabaseKey: " sb_secret_x " });
	assert.deepEqual([sb?.supabaseUrl, sb?.supabaseKey], ["https://a.supabase.co", "sb_secret_x"]);
	assert.equal(parseStorage({ kind: "nube" }), null);
});

// ───────────────────────────── Supabase (API REST simulada) ─────────────────────────────

type Row = Record<string, unknown>;

/** Imita lo que usa Shiro de PostgREST: select, filtros eq/in, order, limit, upsert y return=representation. */
function fakeSupabase(opts: { missing?: string[] } = {}) {
	const tables: Record<string, Row[]> = { shiro_chats: [], shiro_chat_links: [], shiro_memories: [], shiro_reminders: [] };
	const keys: Record<string, string[]> = { shiro_chats: ["id"], shiro_chat_links: ["channel", "external_id"], shiro_memories: ["id"], shiro_reminders: ["id"] };
	const calls: string[] = [];
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		calls.push(`${method} ${url.pathname}${url.search}`);
		assert.equal(headers.get("apikey"), "sb_secret_prueba");
		const table = url.pathname.replace(/^\/rest\/v1\//, "");
		if (opts.missing?.includes(table) || !tables[table]) {
			return new Response(JSON.stringify({ code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` }), { status: 404 });
		}
		const filters: [string, (v: unknown) => boolean][] = [];
		for (const [k, v] of url.searchParams) {
			if (["select", "order", "limit", "on_conflict"].includes(k)) continue;
			if (v.startsWith("eq.")) filters.push([k, (x) => String(x) === v.slice(3)]);
			else if (v.startsWith("in.(")) {
				const list = v.slice(4, -1).split(",").map((s) => JSON.parse(s));
				filters.push([k, (x) => list.includes(String(x))]);
			}
		}
		const match = (r: Row) => filters.every(([k, f]) => f(r[k]));
		const pick = (r: Row) => {
			const sel = url.searchParams.get("select");
			if (!sel || sel === "*") return r;
			return Object.fromEntries(sel.split(",").map((c) => [c, r[c]]));
		};
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const representation = headers.get("prefer")?.includes("return=representation");
		const out = (rows: Row[]) => new Response(representation || method === "GET" ? JSON.stringify(rows.map(pick)) : "", { status: 200 });
		if (method === "GET") {
			let rows = tables[table].filter(match);
			const order = url.searchParams.get("order");
			if (order) {
				const [col, dir] = order.split(".");
				rows = [...rows].sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === "desc" ? -1 : 1));
			}
			const limit = Number(url.searchParams.get("limit") ?? Infinity);
			return out(rows.slice(0, limit));
		}
		if (method === "POST") {
			for (const row of Array.isArray(body) ? body : [body]) {
				const k = keys[table];
				const i = tables[table].findIndex((r) => k.every((c) => r[c] === row[c]));
				if (i >= 0) tables[table][i] = { ...tables[table][i], ...row };
				else tables[table].push(row);
			}
			return out([]);
		}
		if (method === "PATCH") {
			const rows = tables[table].filter(match);
			for (const r of rows) Object.assign(r, body);
			return out(rows);
		}
		const removed = tables[table].filter(match);
		tables[table] = tables[table].filter((r) => !match(r));
		if (table === "shiro_chats") tables.shiro_chat_links = tables.shiro_chat_links.filter((l) => !removed.some((r) => r.id === l.session_id));
		return out(removed);
	};
	return { tables, calls, fetchImpl };
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

const SB = { kind: "supabase" as const, supabaseUrl: "https://demo.supabase.co", supabaseKey: "sb_secret_prueba" };

test("Supabase: detecta la clave pública y las tablas que faltan", async () => {
	assert.match(supabase.supabaseKeyProblem("sb_publishable_abc") ?? "", /pública/);
	const anonJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.firma`;
	assert.match(supabase.supabaseKeyProblem(anonJwt) ?? "", /pública/);
	assert.equal(supabase.supabaseKeyProblem("sb_secret_prueba"), null);
	assert.equal(supabase.normalizeSupabaseUrl("https://demo.supabase.co/rest/v1/"), "https://demo.supabase.co");

	const fake = fakeSupabase({ missing: ["shiro_reminders"] });
	const r = await withFetch(fake.fetchImpl as typeof fetch, () => testStorage(SB));
	assert.equal(r.ok, false);
	assert.ok(!r.ok && r.missingTables && /SQL/.test(r.error));
	const ok = await withFetch(fakeSupabase().fetchImpl as typeof fetch, () => testStorage(SB));
	assert.deepEqual(ok, { ok: true });
});

test("Supabase: llevar los datos y usar chats, recuerdos y recordatorios", async () => {
	const fake = fakeSupabase();
	await withFetch(fake.fetchImpl as typeof fetch, async () => {
		setConfig({ storage: "local" });
		const localChats = await chats.listChatSessions();
		const result = await migrateStorage(LOCAL, SB);
		assert.equal(result.chats, localChats.length);
		assert.equal(fake.tables.shiro_chats.length, localChats.length);
		assert.ok(fake.tables.shiro_memories.length >= 3);
		assert.ok(fake.tables.shiro_reminders.some((r) => (r.data as { title: string }).title === "Llamar a mamá"));

		setConfig({ storage: "supabase", supabaseUrl: SB.supabaseUrl, supabaseKey: SB.supabaseKey });
		assert.equal(getConfig().storage, "supabase");
		const c = await chats.createChatSession([{ role: "user", content: "Hola desde la nube" }]);
		assert.equal((await chats.listChatSessions())[0].id, c.id);
		await chats.saveChatSession(c.id, [
			{ role: "user", content: "Hola desde la nube" },
			{ role: "assistant", content: "Guardado en Supabase" },
		]);
		assert.equal((await chats.getChatSession(c.id))?.lastPreview, "Guardado en Supabase");
		const linked = await chats.getOrCreateLinkedChatSession("whatsapp-web", "123@c.us", "WhatsApp");
		assert.equal((await chats.getOrCreateLinkedChatSession("whatsapp-web", "123@c.us")).id, linked.id);
		assert.equal(await chats.deleteChatSession(c.id), true);
		assert.equal(await chats.getChatSession(c.id), null);

		await memories.addMemory({ content: "Vive en Chile" });
		assert.equal((await memories.searchMemories("chile", 3))[0]?.content, "Vive en Chile");

		const r = await reminders.createReminder({ title: "Pagar luz", datetime: "2031-01-01T09:00:00.000Z" });
		assert.ok((await reminders.getReminders()).some((x) => x.id === r.id));
		assert.equal(await reminders.deleteReminder(r.id), true);
		assert.ok(!fake.tables.shiro_reminders.some((x) => x.id === r.id));
	});
	setConfig({ storage: "local" });
});

test("se quita lo que no se usa: HEARTBEAT.md, memory/ (sus notas pasan a Recuerdos) y el registro de decisiones", () => {
	setConfig({ storage: "obsidian", obsidianVault: VAULT });
	const root = join(VAULT, "Shiro");
	writeFileSync(
		join(root, "HEARTBEAT.md"),
		"# HEARTBEAT.md — Tareas periódicas\n\nLista corta de cosas que revisar cuando haya un heartbeat (ej. recordatorios, comprobaciones).\n\n- [ ] Revisar si hay algo urgente\n- [ ] Actualizar memory/ con lo relevante del día\n\nSi no hay nada que hacer, responde HEARTBEAT_OK.\n",
	);
	mkdirSync(join(root, "memory"), { recursive: true });
	writeFileSync(join(root, "memory", "2026-10-01.md"), "Le gusta el café de Mérida\n");
	mkdirSync(join(DATA_DIR, "logs", "decisions"), { recursive: true });
	writeFileSync(join(DATA_DIR, "logs", "decisions", "2026-10-01.jsonl"), "{}\n");
	ensureWorkspace();
	assert.ok(!existsSync(join(DATA_DIR, "logs")));
	assert.ok(!existsSync(join(root, "HEARTBEAT.md")));
	assert.ok(!existsSync(join(root, "memory")));
	assert.ok(existsSync(join(root, "Recuerdos", "2026-10-01.md")), "la nota no se pierde");
	for (const f of ["SOUL.md", "MEMORY.md", "TOOLS.md", "Instrucciones.md", "Sobre mí.md"]) assert.ok(existsSync(join(root, f)), f);
});

test("rehacer la estructura: recupera de la copia de data/ lo que falte y no toca lo demás", async () => {
	setConfig({ storage: "obsidian", obsidianVault: VAULT });
	const root = join(VAULT, "Shiro");
	await chats.createChatSession([{ role: "user", content: "Hola desde Obsidian" }]);
	writeFileSync(join(root, "SOUL.md"), "# Soy Aku, editado a mano\n");
	backupVault();
	const backup = backupDirFor(root);
	assert.ok(backup.startsWith(join(TMP, "data", "copia-obsidian")));
	assert.equal(readFileSync(join(backup, "SOUL.md"), "utf-8"), "# Soy Aku, editado a mano\n");
	assert.ok(existsSync(join(backup, "Recuerdos", "2026-10-01.md")));

	// Se borran cosas de la bóveda; otras se cambian después de la copia.
	rmSync(join(root, "SOUL.md"));
	rmSync(join(root, "Recuerdos", "2026-10-01.md"));
	rmSync(join(root, "Recordatorios.md"));
	rmSync(join(root, "Chats"), { recursive: true });
	writeFileSync(join(root, "MEMORY.md"), "# MEMORY.md\n\n- Cambiado después de la copia\n");

	const r = await rebuildStructure();
	assert.equal(readFileSync(join(root, "SOUL.md"), "utf-8"), "# Soy Aku, editado a mano\n", "SOUL.md vuelve de la copia");
	assert.ok(existsSync(join(root, "Recuerdos", "2026-10-01.md")));
	assert.match(readFileSync(join(root, "MEMORY.md"), "utf-8"), /Cambiado después de la copia/, "lo que existe no se toca");
	assert.ok(r.restored >= 2 && r.chats >= 1 && r.reminders);
	assert.ok(readdirSync(join(root, "Chats")).some((f) => f.includes("Hola desde Obsidian")));

	const again = await rebuildStructure();
	assert.deepEqual(again, { restored: 0, chats: 0, reminders: false }, "si no falta nada, no hace nada");
	setConfig({ storage: "local" });
});
