/**
 * Modelos GGUF que hay en este equipo, para el llama.cpp integrado (proveedor "gguf").
 * Se buscan en data/models, en las carpetas de LM Studio, en los modelos ya bajados con
 * Ollama (sus "blobs" son archivos GGUF) y en las carpetas que el usuario añada en Ajustes.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DATA_DIR, getConfig } from "../../config/config.js";

export type GgufSource = "shiro" | "lmstudio" | "ollama" | "carpeta";

export type GgufModel = {
	/** Nombre con el que se elige (config llmModel): "Qwen3-8B-Q5_K_M" o "qwen3:8b" (Ollama). */
	id: string;
	path: string;
	sizeBytes: number;
	source: GgufSource;
	/** Proyector de visión (mmproj) que acompaña al modelo, si lo hay. */
	mmproj?: string;
};

/** Carpeta propia de Shiro para dejar archivos .gguf. */
export const MODELS_DIR = join(DATA_DIR, "models");

export const SOURCE_LABELS: Record<GgufSource, string> = {
	shiro: "Shiro",
	lmstudio: "LM Studio",
	ollama: "Ollama",
	carpeta: "Carpeta",
};

const MAX_DEPTH = 5;
const MAX_ENTRIES = 20_000;
/** Partes de un modelo partido: "modelo-00001-of-00003.gguf". */
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;
/** Modelos de embeddings: no sirven para conversar. */
const EMBEDDING = /embed|bge-|e5-|minilm|rerank/i;
/** Carpetas que nunca tienen modelos y pueden ser enormes. */
const SKIP_DIRS = new Set(["node_modules", ".git", "$recycle.bin", "system volume information"]);

/** true si el archivo empieza por la firma de GGUF. */
export function isGgufFile(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(4);
		return readSync(fd, buf, 0, 4, 0) === 4 && buf.toString("latin1") === "GGUF";
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const sizeOf = (path: string) => {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
};

type Found = Omit<GgufModel, "id"> & { name: string };

/**
 * Busca archivos .gguf dentro de una carpeta (hasta 5 niveles). Los mmproj no son modelos:
 * se asignan a los modelos de su misma carpeta. De un modelo partido solo sale la primera parte.
 */
export function scanGgufFolder(root: string, source: GgufSource): Found[] {
	const out: Found[] = [];
	let seen = 0;
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const ggufs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf")).map((e) => e.name);
		const mmproj = ggufs.find((n) => /mmproj/i.test(n));
		for (const name of ggufs) {
			if (/mmproj/i.test(name) || EMBEDDING.test(name)) continue;
			const split = SPLIT.exec(name);
			if (split && Number(split[1]) !== 1) continue;
			const path = join(dir, name);
			let sizeBytes = sizeOf(path);
			if (split) {
				const prefix = name.slice(0, split.index);
				for (const other of ggufs) if (other !== name && other.startsWith(prefix) && SPLIT.test(other)) sizeBytes += sizeOf(join(dir, other));
			}
			out.push({
				name: name.replace(SPLIT, "").replace(/\.gguf$/i, ""),
				path,
				sizeBytes,
				source,
				...(mmproj ? { mmproj: join(dir, mmproj) } : {}),
			});
		}
		if (depth >= MAX_DEPTH) return;
		for (const e of entries) {
			if (++seen > MAX_ENTRIES) return;
			if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name.toLowerCase())) walk(join(dir, e.name), depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

type OllamaManifest = { layers?: { mediaType?: string; digest?: string }[] };

/** Nombre de Ollama a partir de la ruta del manifiesto: library/qwen3/8b → "qwen3:8b". */
export function ollamaName(parts: string[]): string {
	const [registry, ns, model, tag] = parts;
	const base = registry === "registry.ollama.ai" ? (ns === "library" ? model : `${ns}/${model}`) : `${registry}/${ns}/${model}`;
	return `${base}:${tag}`;
}

/** Modelos bajados con Ollama: sus manifiestos dicen qué blob es el GGUF (y el proyector de visión). */
export function scanOllama(modelsDir: string): Found[] {
	const manifests = join(modelsDir, "manifests");
	const blob = (digest?: string) => (digest && /^sha256:[a-f0-9]{64}$/.test(digest) ? join(modelsDir, "blobs", digest.replace(":", "-")) : undefined);
	const out: Found[] = [];
	const walk = (dir: string, parts: string[]) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory() && parts.length < 3) walk(full, [...parts, e.name]);
			else if (e.isFile() && parts.length === 3) {
				const name = ollamaName([...parts, e.name]);
				if (EMBEDDING.test(name)) continue;
				let manifest: OllamaManifest;
				try {
					manifest = JSON.parse(readFileSync(full, "utf-8")) as OllamaManifest;
				} catch {
					continue;
				}
				const layers = manifest.layers ?? [];
				const path = blob(layers.find((l) => l.mediaType === "application/vnd.ollama.image.model")?.digest);
				if (!path || !isGgufFile(path)) continue;
				const mmproj = blob(layers.find((l) => l.mediaType === "application/vnd.ollama.image.projector")?.digest);
				out.push({ name, path, sizeBytes: sizeOf(path), source: "ollama", ...(mmproj && existsSync(mmproj) ? { mmproj } : {}) });
			}
		}
	};
	walk(manifests, []);
	return out;
}

/** Carpetas donde se busca, en orden. */
export function modelFolders(): { dir: string; source: GgufSource }[] {
	const home = homedir();
	const extra = getConfig().ggufFolders.map((p) => resolve(p));
	return [
		{ dir: MODELS_DIR, source: "shiro" as const },
		{ dir: join(home, ".lmstudio", "models"), source: "lmstudio" as const },
		{ dir: join(home, ".cache", "lm-studio", "models"), source: "lmstudio" as const },
		...extra.map((dir) => ({ dir, source: "carpeta" as const })),
	];
}

function ollamaDir(): string {
	return process.env.OLLAMA_MODELS?.trim() || join(homedir(), ".ollama", "models");
}

/** Pone nombres únicos: si dos archivos se llaman igual, se añade la carpeta (o "Ollama"). */
export function assignIds(found: Found[]): GgufModel[] {
	const count = new Map<string, number>();
	for (const f of found) count.set(f.name.toLowerCase(), (count.get(f.name.toLowerCase()) ?? 0) + 1);
	const used = new Set<string>();
	return found.map(({ name, ...rest }) => {
		let id = name;
		if ((count.get(name.toLowerCase()) ?? 0) > 1) id = `${name} · ${rest.source === "ollama" ? "Ollama" : basename(dirname(rest.path))}`;
		for (let n = 2; used.has(id.toLowerCase()); n++) id = `${name} (${n})`;
		used.add(id.toLowerCase());
		return { id, ...rest };
	});
}

let cache: { key: string; at: number; models: GgufModel[] } | null = null;
const CACHE_MS = 10_000;

/** Todos los modelos GGUF del equipo (se recalcula como mucho cada 10 s). */
export function listGgufModels(opts: { fresh?: boolean } = {}): GgufModel[] {
	const folders = modelFolders();
	const key = JSON.stringify([folders, ollamaDir()]);
	if (!opts.fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.models;
	try {
		mkdirSync(MODELS_DIR, { recursive: true });
	} catch {
		// Sin permiso para crearla: se busca en las demás.
	}
	const found: Found[] = [];
	const seenPaths = new Set<string>();
	const seenDirs = new Set<string>();
	for (const { dir, source } of folders) {
		const key = resolve(dir).toLowerCase();
		// Una carpeta extra dentro de otra ya buscada (o repetida) no se busca dos veces.
		if ([...seenDirs].some((d) => key === d || !relative(d, key).startsWith(".."))) continue;
		seenDirs.add(key);
		for (const f of scanGgufFolder(dir, source)) {
			if (seenPaths.has(f.path.toLowerCase())) continue;
			seenPaths.add(f.path.toLowerCase());
			found.push(f);
		}
	}
	found.push(...scanOllama(ollamaDir()));
	const models = assignIds(found);
	cache = { key, at: Date.now(), models };
	return models;
}

/**
 * El modelo elegido en la configuración: por nombre de la lista, o una ruta completa a un .gguf.
 * undefined si no existe.
 */
export function findGgufModel(idOrPath: string): GgufModel | undefined {
	const wanted = idOrPath.trim();
	if (!wanted) return undefined;
	const models = listGgufModels();
	const lower = wanted.toLowerCase();
	const hit =
		models.find((m) => m.id === wanted) ??
		models.find((m) => m.id.toLowerCase() === lower) ??
		models.find((m) => basename(m.path).toLowerCase() === lower);
	if (hit) return hit;
	if (isAbsolute(wanted) && lower.endsWith(".gguf") && isGgufFile(wanted)) {
		const dir = dirname(wanted);
		const inDir = scanGgufFolder(dir, "carpeta").find((f) => f.path.toLowerCase() === resolve(wanted).toLowerCase());
		return { id: wanted, path: resolve(wanted), sizeBytes: sizeOf(wanted), source: "carpeta", ...(inDir?.mmproj ? { mmproj: inDir.mmproj } : {}) };
	}
	return undefined;
}
