import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../../config/config.js";
import { buildSkillsBlock, findSkillDirs, getEnabledSkills, listSkillGroups, parseSkillMarkdown, resolveInsideSkill, skillSlug, type Skill } from "./SkillLoader.js";

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
