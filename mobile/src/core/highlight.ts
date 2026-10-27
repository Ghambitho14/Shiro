/**
 * Colores para los bloques de código (lo que hace highlight.js en la web, en pequeño): comentarios,
 * cadenas, números y palabras clave de los lenguajes más comunes.
 */
export type TokenKind = "plain" | "comment" | "string" | "number" | "keyword";
export type Token = { kind: TokenKind; text: string };

const KEYWORDS = new Set(
	(
		"const let var function return if else for while do break continue switch case default new class extends import from export as async await try catch finally throw typeof instanceof in of this null undefined true false void yield static public private protected interface type enum implements readonly " +
		"def lambda pass elif with yield None True False and or not is global nonlocal raise except self print " +
		"fn mut pub struct impl use mod match loop crate where trait " +
		"func package go defer chan map range select " +
		"int float double char bool boolean string long short byte unsigned signed sizeof struct include define " +
		"echo fi then done esac local"
	).split(" "),
);

const TOKEN = /(\/\/[^\n]*|#(?!include|define)[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

/** `lang` decide si «#» es comentario (Python, bash, YAML…) o no (CSS, Markdown, C). */
export function tokenize(code: string, lang = ""): Token[] {
	const hashComments = /^(py|python|sh|bash|shell|zsh|yaml|yml|toml|rb|ruby|r|ps1|powershell|dockerfile|make|makefile)$/i.test(lang);
	const out: Token[] = [];
	let last = 0;
	for (const m of code.matchAll(TOKEN)) {
		const t = m[0];
		const at = m.index ?? 0;
		if (t.startsWith("#") && !hashComments) continue;
		if (at > last) out.push({ kind: "plain", text: code.slice(last, at) });
		const kind: TokenKind =
			t.startsWith("//") || t.startsWith("#") || t.startsWith("/*")
				? "comment"
				: /^["'`]/.test(t)
					? "string"
					: /^\d/.test(t)
						? "number"
						: KEYWORDS.has(t)
							? "keyword"
							: "plain";
		out.push({ kind, text: t });
		last = at + t.length;
	}
	if (last < code.length) out.push({ kind: "plain", text: code.slice(last) });
	// Juntar trozos normales seguidos (menos elementos que pintar).
	return out.reduce<Token[]>((acc, tok) => {
		const prev = acc[acc.length - 1];
		if (prev && prev.kind === tok.kind && tok.kind === "plain") prev.text += tok.text;
		else acc.push({ ...tok });
		return acc;
	}, []);
}

/** Tablas de Markdown: | a | b | con la fila de guiones debajo de la cabecera. */
export function parseTable(lines: string[]): { head: string[]; rows: string[][] } | null {
	if (lines.length < 2 || !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[1])) return null;
	const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
	const head = cells(lines[0]);
	if (head.length < 2) return null;
	return { head, rows: lines.slice(2).map((l) => {
		const r = cells(l);
		return head.map((_, i) => r[i] ?? "");
	}) };
}
