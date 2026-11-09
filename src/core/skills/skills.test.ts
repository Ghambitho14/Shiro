import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../../config/config.js";
import { APP_DIR } from "../../runtime.js";
import { BUNDLED_SKILLS } from "../../workspace.js";
import {
	buildSkillsBlock,
	copyAllSkillsToShiro,
	copySkillToShiro,
	deleteOwnSkill,
	findSkillDirs,
	getEnabledSkills,
	listSkillGroups,
	parseSkillMarkdown,
	resolveInsideSkill,
	SHIRO_SKILLS_DIR,
	SKILL_PAGE_CHARS,
	skillSlug,
	useSkill,
	type Skill,
} from "./SkillLoader.js";

/** Una carpeta personal de mentira con las habilidades que pide `files`. */
function withFakeHome(files: Record<string, string>, fn: () => void): void {
	const home = mkdtempSync(join(tmpdir(), "shiro-home-"));
	const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
	try {
		process.env.USERPROFILE = process.env.HOME = home;
		for (const [rel, text] of Object.entries(files)) {
			mkdirSync(join(home, rel, ".."), { recursive: true });
			writeFileSync(join(home, rel), text);
		}
		fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	}
}

test("las habilidades de Shiro: la lista coincide con la carpeta, y llegan solas sin pisar cambios", () => {
	const inRepo = readdirSync(join(APP_DIR, "skills")).sort();
	assert.deepEqual(inRepo, [...BUNDLED_SKILLS].sort());
	for (const name of BUNDLED_SKILLS) {
		const { meta, body } = parseSkillMarkdown(readFileSync(join(APP_DIR, "skills", name, "SKILL.md"), "utf-8"));
		assert.equal(meta.name, name);
		assert.ok(meta.description?.length > 20, name);
		assert.ok(body.length > 100, name);
	}
	const own = listSkillGroups().find((g) => g.source === "shiro")!;
	for (const name of BUNDLED_SKILLS) assert.ok(own.skills.some((s) => s.name === name), name);
	assert.ok(useSkill("pentest-informe").content.includes("Informe de pruebas de seguridad"));
});

test("copiar una habilidad a Shiro trae todos sus archivos, queda propia y no pisa la que ya está", () => {
	withFakeHome(
		{
			".claude/skills/zz-copia-test/SKILL.md": "---\nname: zz-copia-test\ndescription: original\n---\nInstrucciones",
			".claude/skills/zz-copia-test/references/guia.md": "guía",
			".claude/skills/zz-copia-test/node_modules/x/index.js": "no se copia",
			".claude/skills/synced/cuenta/zz-apagada-test/SKILL.md": "---\nname: zz-apagada-test\ndescription: de la app\n---\nx",
			".codex/skills/zz-copia-test/SKILL.md": "---\nname: zz-copia-test\ndescription: otra igual\n---\ny",
		},
		() => {
			// «Copiar todas» solo toma las de Claude (synced), no lo instalado de otros autores ni otras apps.
			const results = copyAllSkillsToShiro();
			try {
				assert.deepEqual(
					results.map((r) => [r.id, r.copied]),
					[["shiro:zz-apagada-test", true]],
				);
				assert.equal(existsSync(join(SHIRO_SKILLS_DIR, "zz-copia-test")), false);
				// La segunda vez ya está: no se copia nada ni se pisa.
				assert.deepEqual(copyAllSkillsToShiro().map((r) => r.copied), [false]);
				// Estaba apagada: la API la deja apagada con este dato.
				assert.equal(results[0].enabled, false);
				// Una por una sí se puede copiar cualquiera.
				const instalada = listSkillGroups().find((g) => g.source === "claude")!.skills.find((s) => s.name === "zz-copia-test")!;
				assert.deepEqual(copySkillToShiro(instalada.id), { id: "shiro:zz-copia-test", copied: true, enabled: instalada.enabled });
				const dir = join(SHIRO_SKILLS_DIR, "zz-copia-test");
				assert.ok(existsSync(join(dir, "references", "guia.md")));
				assert.equal(existsSync(join(dir, "node_modules")), false);
				assert.equal(readdirSync(SHIRO_SKILLS_DIR).some((n) => n.startsWith(".copiando")), false);
				// La copia manda sobre la original, y una ya editada no se pisa.
				const active = getEnabledSkills().filter((s) => s.name === "zz-copia-test");
				assert.deepEqual(active.map((s) => s.source), ["shiro"]);
				writeFileSync(join(dir, "SKILL.md"), "---\nname: zz-copia-test\ndescription: editada\n---\nmía");
				const original = listSkillGroups().find((g) => g.source === "claude")!.skills[0];
				assert.equal(copySkillToShiro(original.id).copied, false);
				assert.ok(readFileSync(join(dir, "SKILL.md"), "utf-8").includes("mía"));
				assert.throws(() => copySkillToShiro("shiro:zz-copia-test"), /ya es de Aku/);
			} finally {
				deleteOwnSkill("shiro:zz-copia-test");
				deleteOwnSkill("shiro:zz-apagada-test");
			}
		},
	);
});

test("use_skill entrega las habilidades largas por partes, sin perder nada", () => {
	const line = "Paso con instrucciones importantes de la habilidad.\n";
	const body = Array.from({ length: 500 }, (_, i) => `${i} ${line}`).join("");
	withFakeHome(
		{
			".claude/skills/zz-larga-test/SKILL.md": `---\nname: zz-larga-test\ndescription: larga\n---\n${body}`,
			".claude/skills/zz-larga-test/references/guia.md": "guía",
		},
		() => {
			let offset = 0;
			let all = "";
			let last = "";
			for (let i = 0; i < 20; i++) {
				const { ok, content } = useSkill("zz-larga-test", undefined, offset);
				assert.equal(ok, true);
				assert.ok(content.length <= SKILL_PAGE_CHARS + 200);
				const next = /offset=(\d+)/.exec(content);
				last = content;
				if (!next) break;
				all += content.slice(0, content.indexOf("\n\n[Sigue"));
				offset = Number(next[1]);
			}
			assert.ok(all.includes("0 Paso"));
			assert.ok(last.includes("499 Paso"), "la última parte llega hasta el final");
			// La lista de archivos va al final, para no gastar espacio en cada parte.
			assert.ok(last.includes("references/guia.md"));
			assert.equal(useSkill("zz-larga-test").content.includes("references/guia.md"), false);
			assert.equal(useSkill("zz-larga-test", undefined, 10_000_000).ok, false);
		},
	);
});

test("lee el encabezado de un SKILL.md (comillas, bloques > y |)", () => {
	const a = parseSkillMarkdown(`---\nname: pdf\ndescription: "Lee y crea PDFs: \\"formularios\\" incluidos"\n---\n\n# PDF\nPasos...`);
	assert.equal(a.meta.name, "pdf");
	assert.equal(a.meta.description, 'Lee y crea PDFs: "formularios" incluidos');
	assert.equal(a.body, "# PDF\nPasos...");

	const b = parseSkillMarkdown(`﻿---\r\nname: video\r\ndescription: >\r\n  Hace vídeos\r\n  con HTML.\r\nlicense: MIT\r\n---\r\nCuerpo`);
	assert.equal(b.meta.description, "Hace vídeos con HTML.");
	assert.equal(b.meta.license, "MIT");
	assert.equal(b.body, "Cuerpo");

	const c = parseSkillMarkdown("Sin encabezado\nNada más");
	assert.deepEqual(c.meta, {});
	assert.equal(c.body, "Sin encabezado\nNada más");
});

test("nombre de carpeta de una habilidad", () => {
	assert.equal(skillSlug("Resumir Correos"), "resumir-correos");
	assert.equal(skillSlug("  Cómo ñandú!! "), "como-nandu");
	assert.equal(skillSlug("../../etc"), "etc");
	assert.equal(skillSlug("???"), "");
});

test("encuentra habilidades hasta 3 niveles (como la carpeta synced de Claude) sin entrar en ellas", () => {
	const root = mkdtempSync(join(tmpdir(), "shiro-skills-"));
	try {
		const mk = (rel: string) => {
			mkdirSync(join(root, rel), { recursive: true });
			writeFileSync(join(root, rel, "SKILL.md"), `---\nname: ${rel.split("/").pop()}\ndescription: d\n---\nx`);
		};
		mk("uno");
		mk("synced/abc/dos");
		mk("uno/references/no-cuenta");
		mk("a/b/c/demasiado-hondo");
		mkdirSync(join(root, "node_modules", "x"), { recursive: true });
		writeFileSync(join(root, "node_modules", "x", "SKILL.md"), "x");
		const found = findSkillDirs(root).map((d) => d.slice(root.length + 1).replace(/\\/g, "/"));
		assert.deepEqual(found.sort(), ["synced/abc/dos", "uno"]);
		assert.deepEqual(findSkillDirs(join(root, "no-existe")), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("use_skill no puede leer archivos fuera de la carpeta de la habilidad", () => {
	const root = mkdtempSync(join(tmpdir(), "shiro-skill-"));
	try {
		const dir = join(root, "mi-skill");
		mkdirSync(join(dir, "references"), { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "x");
		writeFileSync(join(dir, "references", "guia.md"), "guía");
		writeFileSync(join(root, "secreto.txt"), "no");
		assert.ok(resolveInsideSkill(dir, "references/guia.md")?.endsWith("guia.md"));
		assert.equal(resolveInsideSkill(dir, "../secreto.txt"), null);
		assert.equal(resolveInsideSkill(dir, join(root, "secreto.txt")), null);
		assert.equal(resolveInsideSkill(dir, "references"), null); // carpeta, no archivo
		assert.equal(resolveInsideSkill(dir, "no-existe.md"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("la lista para el modelo pone primero las habilidades relacionadas y respeta el tamaño", () => {
	const skill = (name: string, description: string): Skill => ({ id: `t:${name}`, source: "t", name, description, dir: "", file: "", enabled: true, builtIn: false });
	const skills = [skill("excel", "Crea hojas de cálculo y tablas"), skill("pdf", "Lee y rellena documentos PDF"), skill("video", "Hace vídeos animados")];
	const block = buildSkillsBlock("rellena este documento pdf por favor", 2000, skills);
	assert.ok(block.startsWith("## Habilidades"));
	assert.ok(block.indexOf("- pdf:") < block.indexOf("- excel:"));
	assert.ok(block.includes("use_skill"));
	// "rellena" ≈ "rellena", "documento" ≈ "documentos": destaca claramente y se recomienda.
	assert.match(block, /parece útil la habilidad "pdf"/);
	// Coincidencia por raíz: "resume este correo" → "resumir correos".
	const mail = [skill("resumir-correos", "Cuando pida resumir correos o mensajes largos"), ...skills];
	assert.match(buildSkillsBlock("Resume este correo por favor: el viernes cerramos", 2000, mail), /parece útil la habilidad "resumir-correos"/);
	// Nada destaca: sin recomendación.
	assert.doesNotMatch(buildSkillsBlock("¿qué hora es?", 2000, skills), /parece útil/);

	const many = Array.from({ length: 60 }, (_, i) => skill(`habilidad-${i}`, "x".repeat(150)));
	const small = buildSkillsBlock("hola", 800, many);
	assert.ok(small.length <= 900);
	assert.match(small, /Hay \d+ más/);
	assert.equal(buildSkillsBlock("hola", 800, []), "");
});

test("detecta solas las habilidades de Claude Code y Codex (las que trae la app empiezan apagadas)", () => {
	const home = mkdtempSync(join(tmpdir(), "shiro-home-"));
	const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
	const mk = (rel: string, name = rel.split("/").pop()) => {
		mkdirSync(join(home, rel), { recursive: true });
		writeFileSync(join(home, rel, "SKILL.md"), `---\nname: ${name}\ndescription: prueba ${rel}\n---\nx`);
	};
	try {
		process.env.USERPROFILE = process.env.HOME = home;
		mk(".claude/skills/zz-mia-shiro-test");
		mk(".claude/skills/synced/cuenta-a/zz-docx-shiro-test");
		mk(".claude/skills/synced/cuenta-b/zz-docx-shiro-test");
		mk(".codex/skills/.system/zz-imagegen-shiro-test");
		mk(".codex/skills/.oculta/zz-no-cuenta-shiro-test");
		mk(".codex/skills/zz-otra-shiro-test");

		const off = new Set(getConfig().disabledSkillSources);
		const groups = listSkillGroups();
		const claude = groups.find((g) => g.source === "claude")!;
		const codex = groups.find((g) => g.source === "codex")!;
		assert.equal(claude.exists, true);
		assert.equal(claude.enabled, !off.has("claude"));
		// La copia repetida (dos cuentas) sale una sola vez; primero la del usuario.
		assert.deepEqual(
			claude.skills.map((s) => [s.name, s.builtIn]),
			[
				["zz-mia-shiro-test", false],
				["zz-docx-shiro-test", true],
			],
		);
		assert.deepEqual(
			codex.skills.map((s) => [s.name, s.builtIn]),
			[
				["zz-otra-shiro-test", false],
				["zz-imagegen-shiro-test", true],
			],
		);
		assert.equal(claude.skills[0].enabled, !off.has("claude"));
		assert.equal(claude.skills[1].enabled, false);
		assert.equal(groups.find((g) => g.source === "lmstudio")?.exists, false);

		const names = getEnabledSkills().map((s) => s.name);
		assert.equal(names.includes("zz-mia-shiro-test"), !off.has("claude"));
		assert.equal(names.includes("zz-docx-shiro-test"), false);
		assert.equal(names.includes("zz-imagegen-shiro-test"), false);
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	}
});
