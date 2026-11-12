/**
 * Diferencias línea a línea entre dos textos (tarjeta «Cambios» del modo Code), sin librerías.
 * Quita lo común del principio y del final y compara el resto con LCS; si ese resto es enorme,
 * lo da como un bloque reemplazado (correcto, solo menos fino).
 */

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
export type DiffHunk = { oldStart: number; newStart: number; lines: DiffLine[] };
export type DiffResult = { adds: number; dels: number; hunks: DiffHunk[]; truncated: boolean };

/** Celdas máximas de la tabla LCS (filas × columnas) antes de rendirse a «bloque reemplazado». */
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
	if (!text) return [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	// Un salto de línea final no es una línea vacía más.
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Operaciones de a → b: lista de líneas iguales, añadidas o quitadas, en orden. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const out: DiffLine[] = [];
	for (let i = 0; i < start; i++) out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length * midB.length > MAX_CELLS) {
		midA.forEach((text, i) => out.push({ kind: "del", text, oldNo: start + i + 1 }));
		midB.forEach((text, j) => out.push({ kind: "add", text, newNo: start + j + 1 }));
	} else {
		// LCS clásico: lcs[i][j] = largo de la subsecuencia común de midA[i..] y midB[j..].
		const n = midA.length;
		const m = midB.length;
		const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && midA[i] === midB[j]) {
				out.push({ kind: "same", text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
				i++;
				j++;
			} else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
				// Primero lo quitado y luego lo añadido, como git diff.
				out.push({ kind: "del", text: midA[i], oldNo: start + i + 1 });
				i++;
			} else {
				out.push({ kind: "add", text: midB[j], newNo: start + j + 1 });
				j++;
			}
		}
	}

	const shift = endB - endA;
	for (let i = endA; i < a.length; i++) out.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 + shift });
	return out;
}

/**
 * Las diferencias agrupadas en tramos con `context` líneas iguales alrededor, como `git diff`.
 * Como mucho `maxLines` líneas en total (`truncated` avisa si se cortó). Las líneas muy largas se recortan.
 */
export function diffHunks(before: string, after: string, context = 3, maxLines = 400): DiffResult {
	const lines = diffLines(before, after).map((l) => (l.text.length > 500 ? { ...l, text: `${l.text.slice(0, 500)}…` } : l));
	const adds = lines.filter((l) => l.kind === "add").length;
	const dels = lines.filter((l) => l.kind === "del").length;
	const hunks: DiffHunk[] = [];
	let shown = 0;
	let truncated = false;
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind === "same") {
			i++;
			continue;
		}
		// Un tramo empieza `context` líneas antes del cambio y sigue mientras los cambios estén cerca.
		const from = Math.max(0, i - context);
		let to = i;
		let k = i;
		while (k < lines.length) {
			if (lines[k].kind !== "same") {
				to = k;
				k++;
				continue;
			}
			let next = k;
			while (next < lines.length && lines[next].kind === "same") next++;
			if (next < lines.length && next - k <= context * 2) {
				k = next;
				continue;
			}
			break;
		}
		const end = Math.min(lines.length, to + context + 1);
		let slice = lines.slice(from, end);
		if (shown + slice.length > maxLines) {
			slice = slice.slice(0, Math.max(0, maxLines - shown));
			truncated = true;
		}
		if (slice.length) {
			const firstOld = slice.find((l) => l.oldNo !== undefined)?.oldNo ?? 0;
			const firstNew = slice.find((l) => l.newNo !== undefined)?.newNo ?? 0;
			hunks.push({ oldStart: firstOld, newStart: firstNew, lines: slice });
			shown += slice.length;
		}
		if (truncated) break;
		i = end;
	}
	return { adds, dels, hunks, truncated };
}
