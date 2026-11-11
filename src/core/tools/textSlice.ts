/**
 * Entregar un texto largo por partes y decir cómo seguir. Lo usan project read, read_file,
 * read_file_system y fetch_url: cada una sabe cuánto cabe en su resultado (`currentResultBudget`)
 * y corta ahí con su nota, en vez de que el recorte general se lleve el final sin avisar cómo continuar.
 */

export type TextSlice = {
	/** " (líneas 120–180 de 812)" o " (caracteres 0–8000 de 30000)"; vacío si va el texto entero. */
	range: string;
	body: string;
	/** Cómo seguir leyendo, o "" si ya no queda nada. */
	note: string;
};

export type SliceOptions = {
	/** Primera línea (desde 1). */
	line?: number;
	/** Cuántas líneas. */
	lines?: number;
	/** Letra desde la que seguir (textos sin líneas útiles: PDF, páginas web, archivos de una sola línea). */
	offset?: number;
	/** Letras que caben en el resultado. */
	maxChars: number;
};

const MIN_CHARS = 500;

/** Lanza un Error en español si se pide un tramo que no existe. */
export function sliceText(text: string, o: SliceOptions): TextSlice {
	const max = Math.max(MIN_CHARS, Math.floor(o.maxChars));
	if (o.offset !== undefined && o.line === undefined) return sliceChars(text, Math.max(0, Math.floor(o.offset)), max);

	const all = text.split(/\r?\n/);
	// Un salto de línea al final no es una línea más.
	if (all.length > 1 && all[all.length - 1] === "") all.pop();
	const total = all.length;
	const start = Math.max(1, Math.floor(o.line ?? 1));
	if (start > total) throw new Error(`El archivo solo tiene ${total} ${total === 1 ? "línea" : "líneas"}.`);
	const wanted = o.lines !== undefined ? Math.max(1, Math.floor(o.lines)) : Number.POSITIVE_INFINITY;

	// Una línea que sola no cabe (JSON en una línea, código minificado): se sigue por letras.
	const first = all[start - 1]!;
	if (first.length > max) {
		const before = all.slice(0, start - 1).reduce((n, l) => n + l.length + 1, 0);
		const cut = sliceChars(text, before, max);
		return { ...cut, note: `\n\n[La línea ${start} es muy larga (${first.length} caracteres): va su principio. Sigue con offset=${before + cut.body.length}.]` };
	}

	const out: string[] = [];
	let used = 0;
	let i = start - 1;
	while (i < total && out.length < wanted) {
		const next = all[i]!;
		if (out.length && used + next.length + 1 > max) break;
		out.push(next);
		used += next.length + 1;
		i++;
	}
	const end = start + out.length - 1;
	const whole = start === 1 && end === total;
	const left = total - end;
	return {
		range: whole ? "" : ` (líneas ${start}–${end} de ${total})`,
		body: out.join("\n"),
		note: left > 0 ? `\n\n[…continúa: quedan ${left} ${left === 1 ? "línea" : "líneas"}. Sigue con line=${end + 1}.]` : "",
	};
}

function sliceChars(text: string, offset: number, max: number): TextSlice {
	if (offset >= text.length && text.length) throw new Error(`El texto solo tiene ${text.length} caracteres.`);
	const body = text.slice(offset, offset + max);
	const end = offset + body.length;
	const left = text.length - end;
	return {
		range: offset || left ? ` (caracteres ${offset}–${end} de ${text.length})` : "",
		body,
		note: left > 0 ? `\n\n[…continúa: quedan ${left} caracteres. Sigue con offset=${end}.]` : "",
	};
}

/** Sin tildes ni mayúsculas, para comparar. */
export const foldText = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Palabras de una búsqueda (de dos letras o más). */
export const searchWords = (query: string) => foldText(query).split(/\s+/).filter((w) => w.length > 1);

/**
 * Las líneas de un texto que contienen todas las palabras, con `context` líneas alrededor, hasta
 * `maxChars`. Para ir a lo que se busca en una página o un archivo largo sin leerlo entero.
 */
export function findInText(text: string, query: string, o: { context?: number; maxChars: number }): { body: string; hits: number; shown: number } {
	const words = searchWords(query);
	const lines = text.split(/\r?\n/);
	const hitLines: number[] = [];
	if (words.length) {
		for (let i = 0; i < lines.length; i++) {
			const folded = foldText(lines[i]!);
			if (words.every((w) => folded.includes(w))) hitLines.push(i);
		}
	}
	const ctx = Math.max(0, Math.min(3, Math.floor(o.context ?? 1)));
	const blocks: string[] = [];
	let used = 0;
	let lastEnd = -1;
	let shown = 0;
	for (const i of hitLines) {
		const from = Math.max(lastEnd + 1, i - ctx);
		const to = Math.min(lines.length - 1, i + ctx);
		if (from > to) {
			// La coincidencia ya salió en el contexto del bloque anterior.
			shown++;
			continue;
		}
		const block = lines.slice(from, to + 1).join("\n").trim();
		if (used + block.length + 5 > o.maxChars && blocks.length) break;
		blocks.push(block.slice(0, o.maxChars));
		used += block.length + 5;
		lastEnd = to;
		shown++;
	}
	return { body: blocks.join("\n…\n"), hits: hitLines.length, shown };
}
