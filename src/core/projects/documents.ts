/**
 * Texto de los documentos de un proyecto: archivos de texto tal cual, PDF con unpdf y Word (.docx) con mammoth.
 * Las librerías se cargan solo la primera vez que hacen falta.
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/** Extensiones que se leen como texto (las mismas que acepta el adjuntar de la web, y algunas más). */
const TEXT_EXT = new Set(
	"txt md markdown csv tsv json jsonc log xml yml yaml ini cfg conf toml env js mjs cjs ts tsx jsx py html htm css scss java c cpp h hpp cs go rs php rb sh bat ps1 sql kt swift lua r tex rst vue svelte gitignore dockerfile".split(" "),
);
const DOC_EXT = new Set(["pdf", "docx"]);

/** Tamaño máximo de un archivo que se intenta leer. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function extOf(file: string): string {
	const e = extname(file).slice(1).toLowerCase();
	if (e) return e;
	// Archivos sin extensión con nombre conocido (Dockerfile, Makefile, LICENSE…) se leen como texto.
	return /(^|[\\/])(dockerfile|makefile|license|readme|\.gitignore|\.env[^\\/]*)$/i.test(file) ? "txt" : "";
}

/** true si Shiro sabe sacar el texto de este archivo. */
export function isReadableDocument(file: string): boolean {
	const e = extOf(file);
	return TEXT_EXT.has(e) || DOC_EXT.has(e);
}

/** true si es un archivo de texto plano (se puede escribir). */
export function isTextFile(file: string): boolean {
	return TEXT_EXT.has(extOf(file));
}

const cache = new Map<string, string>();
const CACHE_MAX = 60;

async function pdfText(data: Buffer): Promise<string> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(data));
	const { text } = await extractText(pdf, { mergePages: false });
	return (text as string[]).map((page, i) => `--- Página ${i + 1} ---\n${page.trim()}`).join("\n\n");
}

async function docxText(data: Buffer): Promise<string> {
	const mammoth = (await import("mammoth")).default ?? (await import("mammoth"));
	const { value } = await mammoth.extractRawText({ buffer: data });
	return value;
}

/** Texto de un documento. Lanza un Error en español si no se puede leer. */
export async function extractText(file: string): Promise<string> {
	const st = statSync(file);
	if (!st.isFile()) throw new Error("No es un archivo.");
	if (st.size > MAX_DOCUMENT_BYTES) throw new Error("El archivo es demasiado grande (máx. 25 MB).");
	const key = `${file}|${st.mtimeMs}|${st.size}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;

	const e = extOf(file);
	let text: string;
	if (TEXT_EXT.has(e)) {
		text = readFileSync(file, "utf-8").replace(/^﻿/, "");
	} else if (e === "pdf") {
		try {
			text = await pdfText(readFileSync(file));
		} catch (err) {
			throw new Error(`No pude leer el PDF: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!text.replace(/--- Página \d+ ---/g, "").trim()) {
			throw new Error("El PDF no tiene texto (parece escaneado: solo imágenes).");
		}
	} else if (e === "docx") {
		try {
			text = await docxText(readFileSync(file));
		} catch (err) {
			throw new Error(`No pude leer el documento de Word: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		throw new Error(e ? `No sé leer archivos .${e} todavía (solo texto, PDF y Word .docx).` : "No sé leer este tipo de archivo.");
	}

	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(key, text);
	return text;
}
