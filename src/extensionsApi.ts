/**
 * API de la web para Ajustes → Habilidades y Ajustes → Conectores MCP, y la lista de comandos del chat.
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { getConfig, setConfig } from "./config/config.js";
import { COMMANDS } from "./commands.js";
import {
	EXTERNAL_SKILL_SOURCES,
	SHIRO_SKILLS_DIR,
	deleteOwnSkill,
	findSkillById,
	getEnabledSkills,
	importOwnSkill,
	listSkillGroups,
	readSkillDetails,
	saveOwnSkill,
} from "./core/skills/SkillLoader.js";
import {
	MCP_CONFIG_FILE,
	isValidServerName,
	loadMcpServers,
	mcpImportSources,
	readImportSource,
	readMcpRaw,
	saveMcpServers,
	splitCommandLine,
	writeMcpRaw,
	type McpServerConfig,
} from "./core/mcp/mcpConfig.js";
import { mcpManager } from "./core/mcp/McpManager.js";
import { shiroMcpCommand } from "./runtime.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

/** Los valores de env y cabeceras (suelen ser claves) no se mandan al navegador. */
export const SECRET_MASK = "••••••";

function homeShort(p: string): string {
	const home = homedir();
	return p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
}

// ───────────────────────────── habilidades ─────────────────────────────

function skillsPayload() {
	const groups = listSkillGroups();
	const toItem = (s: (typeof groups)[number]["skills"][number]) => ({ id: s.id, name: s.name, description: s.description, enabled: s.enabled, builtIn: s.builtIn });
	const own = groups.find((g) => g.source === "shiro")!;
	return {
		own: { dir: homeShort(own.dir), skills: own.skills.map(toItem) },
		folders: groups
			.filter((g) => g.source.startsWith("path:"))
			.map((g) => ({ source: g.source, path: g.label, exists: g.exists, skills: g.skills.map(toItem) })),
		apps: groups
			.filter((g) => EXTERNAL_SKILL_SOURCES.some((s) => s.id === g.source))
			.map((g) => ({ source: g.source, label: g.label, dir: homeShort(g.dir), exists: g.exists, enabled: g.enabled, skills: g.skills.map(toItem) })),
		activeCount: getEnabledSkills().length,
	};
}

function setSkillEnabled(skill: { id: string; builtIn: boolean }, enabled: boolean): void {
	// Las incluidas con otra app empiezan apagadas: se recuerda cuáles se encendieron.
	const key = skill.builtIn ? "enabledSkills" : "disabledSkills";
	const list = new Set(getConfig()[key]);
	if (enabled === skill.builtIn) list.add(skill.id);
	else list.delete(skill.id);
	setConfig({ [key]: [...list] });
}

function forgetSkillId(id: string, replacement?: string): void {
	const list = getConfig().disabledSkills;
	if (!list.includes(id)) return;
	setConfig({ disabledSkills: [...list.filter((x) => x !== id), ...(replacement ? [replacement] : [])] });
}

// ───────────────────────────── MCP ─────────────────────────────

function mask(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	return Object.fromEntries(Object.keys(record).map((k) => [k, SECRET_MASK]));
}

function mcpPayload() {
	const { servers } = loadMcpServers();
	const status = new Map(mcpManager.status().map((s) => [s.name, s]));
	return {
		configFile: homeShort(MCP_CONFIG_FILE),
		configError: mcpManager.getConfigError(),
		servers: Object.entries(servers).map(([name, cfg]) => {
			const st = status.get(name);
			return {
				name,
				config: { ...cfg, env: mask(cfg.env), headers: mask(cfg.headers) },
				kind: cfg.url ? "http" : "stdio",
				target: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].join(" "),
				state: st?.state ?? (cfg.disabled ? "off" : "connecting"),
				error: st?.error,
				serverVersion: st?.serverVersion,
				disabled: cfg.disabled === true,
				tools: st?.tools ?? [],
				log: st?.log ?? [],
			};
		}),
		imports: mcpImportSources()
			.map((src) => {
				const found = readImportSource(src);
				const fresh = Object.keys(found).filter((n) => !(n in servers));
				return { id: src.id, label: src.label, file: homeShort(src.file), count: Object.keys(found).length, fresh: fresh.length };
			})
			.filter((x) => x.count > 0),
		shiroMcp: shiroMcpCommand(),
		/** Para los ejemplos (p. ej. "archivos de Documentos"). */
		home: homedir(),
	};
}

/** Una clave con el valor enmascarado conserva el valor guardado. */
function unmask(next: Record<string, string> | undefined, prev: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!next) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(next)) {
		const key = k.trim();
		if (!key) continue;
		out[key] = v === SECRET_MASK ? prev?.[key] ?? "" : v;
	}
	return Object.keys(out).length ? out : undefined;
}

function cleanServer(input: Record<string, unknown>, prev?: McpServerConfig): McpServerConfig {
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const strMap = (v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>
			: undefined;
	const url = str(input.url);
	// El formulario manda el comando en una línea ("npx -y paquete"); el JSON, command + args.
	const line = !url && typeof input.commandLine === "string" ? splitCommandLine(input.commandLine) : null;
	if (line) {
		input = { ...input, command: line[0], args: line.slice(1) };
	}
	const command = url ? undefined : str(input.command);
	if (!url && !command) throw new Error("Escribe el comando del programa o la URL del servidor.");
	if (url) {
		try {
			const p = new URL(url).protocol;
			if (p !== "http:" && p !== "https:") throw new Error();
		} catch {
			throw new Error("La URL no es válida (debe empezar por http:// o https://).");
		}
	}
	// El formulario no tiene cwd ni type: se conservan los que hubiera.
	const cwd = str(input.cwd) ?? prev?.cwd;
	const type = str(input.type) ?? (prev?.url ? prev.type : undefined);
	const cfg: McpServerConfig = {
		...(command ? { command, args: Array.isArray(input.args) ? input.args.map(String) : [] } : {}),
		...(command && cwd ? { cwd } : {}),
		...(command ? { env: unmask(strMap(input.env), prev?.env) } : {}),
		...(url ? { url, headers: unmask(strMap(input.headers), prev?.headers) } : {}),
		...(url && type ? { type } : {}),
		...(prev?.disabled ? { disabled: true } : {}),
		...(prev?.alwaysAllow?.length ? { alwaysAllow: prev.alwaysAllow } : {}),
		...(prev?.disabledTools?.length ? { disabledTools: prev.disabledTools } : {}),
	};
	for (const k of Object.keys(cfg) as (keyof McpServerConfig)[]) if (cfg[k] === undefined) delete cfg[k];
	return cfg;
}

// ───────────────────────────── rutas ─────────────────────────────

export async function handleExtensionsApi(
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	pathname: string,
	{ readJson, sendJson }: Helpers,
): Promise<boolean> {
	if (method === "GET" && pathname === "/api/commands") {
		sendJson(res, 200, {
			commands: COMMANDS,
			skills: getEnabledSkills().map((s) => ({ name: s.name, description: s.description.replace(/\s+/g, " ").slice(0, 160) })),
		});
		return true;
	}

	if (!pathname.startsWith("/api/skills") && !pathname.startsWith("/api/mcp")) return false;

	const body = async <T = Record<string, unknown>>(): Promise<T> => {
		try {
			return await readJson<T>(req);
		} catch {
			throw new Error("Datos no válidos");
		}
	};

	try {
		// ── Habilidades ──
		if (method === "GET" && pathname === "/api/skills") {
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "PUT" && pathname === "/api/skills/app") {
			const d = await body<{ source?: string; enabled?: boolean }>();
			if (!EXTERNAL_SKILL_SOURCES.some((s) => s.id === d.source)) throw new Error("Aplicación desconocida.");
			const off = new Set(getConfig().disabledSkillSources);
			if (d.enabled) off.delete(d.source!);
			else off.add(d.source!);
			setConfig({ disabledSkillSources: [...off] });
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "PUT" && pathname === "/api/skills/toggle") {
			const d = await body<{ id?: string; enabled?: boolean }>();
			const skill = d.id ? findSkillById(d.id) : undefined;
			if (!skill) throw new Error("No encontré esa habilidad.");
			setSkillEnabled(skill, d.enabled === true);
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "GET" && pathname === "/api/skills/detail") {
			const id = new URL(req.url ?? "", "http://x").searchParams.get("id") ?? "";
			const d = readSkillDetails(id);
			if (!d) throw new Error("No encontré esa habilidad.");
			sendJson(res, 200, { id, name: d.skill.name, description: d.description, body: d.body, editable: d.editable, dir: homeShort(d.skill.dir) });
			return true;
		}
		if (method === "POST" && pathname === "/api/skills") {
			const d = await body<{ name?: string; description?: string; instructions?: string; originalId?: string }>();
			const id = saveOwnSkill({
				name: String(d.name ?? ""),
				description: String(d.description ?? ""),
				instructions: String(d.instructions ?? ""),
				originalId: d.originalId || undefined,
			});
			if (d.originalId && d.originalId !== id) forgetSkillId(d.originalId, id);
			sendJson(res, 200, { id, ...skillsPayload() });
			return true;
		}
		if (method === "POST" && pathname === "/api/skills/import") {
			const d = await body<{ filename?: string; content?: string }>();
			const fallback = String(d.filename ?? "habilidad").replace(/\.md$/i, "").replace(/^SKILL$/i, "habilidad");
			const id = importOwnSkill(String(d.content ?? ""), fallback);
			sendJson(res, 200, { id, ...skillsPayload() });
			return true;
		}
		if (method === "DELETE" && pathname === "/api/skills") {
			const d = await body<{ id?: string }>();
			deleteOwnSkill(String(d.id ?? ""));
			forgetSkillId(String(d.id));
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "POST" && pathname === "/api/skills/folders") {
			const d = await body<{ path?: string }>();
			const p = String(d.path ?? "").trim().replace(/^"|"$/g, "");
			if (!p) throw new Error("Escribe la ruta de la carpeta.");
			const full = resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
			if (!existsSync(full)) throw new Error(`La carpeta ${full} no existe.`);
			const paths = getConfig().skillPaths;
			if (!paths.some((x) => resolve(x) === full)) setConfig({ skillPaths: [...paths, full] });
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "DELETE" && pathname === "/api/skills/folders") {
			const d = await body<{ path?: string }>();
			setConfig({ skillPaths: getConfig().skillPaths.filter((x) => x !== d.path) });
			sendJson(res, 200, skillsPayload());
			return true;
		}
		if (method === "POST" && pathname === "/api/skills/open-folder") {
			mkdirSync(SHIRO_SKILLS_DIR, { recursive: true });
			const { openTarget } = await import("./core/pc/pc.js");
			await openTarget(SHIRO_SKILLS_DIR);
			sendJson(res, 200, { ok: true });
			return true;
		}

		// ── MCP ──
		if (method === "GET" && pathname === "/api/mcp") {
			sendJson(res, 200, mcpPayload());
			return true;
		}
		if (method === "GET" && pathname === "/api/mcp/raw") {
			sendJson(res, 200, { text: readMcpRaw(), file: homeShort(MCP_CONFIG_FILE) });
			return true;
		}
		if (method === "PUT" && pathname === "/api/mcp/raw") {
			const d = await body<{ text?: string }>();
			writeMcpRaw(String(d.text ?? ""));
			await mcpManager.reload();
			sendJson(res, 200, mcpPayload());
			return true;
		}
		if (method === "POST" && pathname === "/api/mcp/import") {
			const d = await body<{ source?: string }>();
			const src = mcpImportSources().find((s) => s.id === d.source);
			if (!src) throw new Error("Origen desconocido.");
			const { servers, error } = loadMcpServers();
			if (error) throw new Error(error);
			const found = readImportSource(src);
			let added = 0;
			for (const [name, cfg] of Object.entries(found)) {
				if (name in servers) continue;
				servers[name] = cfg;
				added++;
			}
			saveMcpServers(servers);
			await mcpManager.reload();
			sendJson(res, 200, { added, ...mcpPayload() });
			return true;
		}

		const m = /^\/api\/mcp\/servers\/([^/]+)(\/restart)?$/.exec(pathname);
		if (m) {
			let name: string;
			try {
				name = decodeURIComponent(m[1]).trim();
			} catch {
				throw new Error("Nombre no válido.");
			}
			const { servers, error } = loadMcpServers();
			if (error) throw new Error(error);

			if (method === "POST" && m[2]) {
				await mcpManager.restart(name);
				sendJson(res, 200, mcpPayload());
				return true;
			}
			if (method === "PUT") {
				// Crear o editar desde el formulario. originalName permite renombrar.
				const d = await body<{ config?: Record<string, unknown>; originalName?: string }>();
				if (!isValidServerName(name)) throw new Error("Nombre no válido: usa letras, números, espacios, - _ . (máx. 40).");
				const original = d.originalName?.trim();
				const prev = original ? servers[original] : undefined;
				if (original && !prev) throw new Error(`No existe el servidor "${original}".`);
				if (name !== original && name in servers) throw new Error(`Ya hay un servidor llamado "${name}".`);
				const cfg = cleanServer(d.config ?? {}, prev);
				if (original && original !== name) delete servers[original];
				servers[name] = cfg;
				saveMcpServers(servers);
				await mcpManager.reload();
				sendJson(res, 200, mcpPayload());
				return true;
			}
			if (!(name in servers)) throw new Error(`No existe el servidor "${name}".`);
			if (method === "PATCH") {
				// Interruptores: encendido, herramientas activas y "sin preguntar".
				const d = await body<{ disabled?: boolean; alwaysAllow?: unknown; disabledTools?: unknown }>();
				const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : undefined);
				const cfg = { ...servers[name] };
				if (typeof d.disabled === "boolean") {
					if (d.disabled) cfg.disabled = true;
					else delete cfg.disabled;
				}
				const allow = list(d.alwaysAllow);
				if (allow) cfg.alwaysAllow = allow.length ? allow : undefined;
				const off = list(d.disabledTools);
				if (off) cfg.disabledTools = off.length ? off : undefined;
				for (const k of ["alwaysAllow", "disabledTools"] as const) if (cfg[k] === undefined) delete cfg[k];
				servers[name] = cfg;
				saveMcpServers(servers);
				await mcpManager.reload();
				sendJson(res, 200, mcpPayload());
				return true;
			}
			if (method === "DELETE") {
				delete servers[name];
				saveMcpServers(servers);
				await mcpManager.reload();
				sendJson(res, 200, mcpPayload());
				return true;
			}
		}

		sendJson(res, 404, { error: "Not found" });
		return true;
	} catch (err) {
		sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		return true;
	}
}
