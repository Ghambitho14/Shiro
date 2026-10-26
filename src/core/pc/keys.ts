/**
 * Traduce atajos escritos por el modelo ("ctrl+c", "alt+tab", "win+d", "intro")
 * a códigos de tecla virtuales de Windows. Acepta nombres en español e inglés.
 */

const MODIFIERS: Record<string, number> = {
	ctrl: 0x11,
	control: 0x11,
	shift: 0x10,
	mayus: 0x10,
	mayusculas: 0x10,
	alt: 0x12,
	altgr: 0xa5,
	win: 0x5b,
	windows: 0x5b,
	super: 0x5b,
	cmd: 0x5b,
};

const NAMED: Record<string, number> = {
	enter: 0x0d,
	intro: 0x0d,
	return: 0x0d,
	esc: 0x1b,
	escape: 0x1b,
	tab: 0x09,
	tabulador: 0x09,
	space: 0x20,
	espacio: 0x20,
	backspace: 0x08,
	retroceso: 0x08,
	borrar: 0x08,
	delete: 0x2e,
	del: 0x2e,
	supr: 0x2e,
	suprimir: 0x2e,
	insert: 0x2d,
	ins: 0x2d,
	home: 0x24,
	inicio: 0x24,
	end: 0x23,
	fin: 0x23,
	pageup: 0x21,
	repag: 0x21,
	pagedown: 0x22,
	avpag: 0x22,
	up: 0x26,
	arriba: 0x26,
	down: 0x28,
	abajo: 0x28,
	left: 0x25,
	izquierda: 0x25,
	right: 0x27,
	derecha: 0x27,
	printscreen: 0x2c,
	impr: 0x2c,
	imprpant: 0x2c,
	capslock: 0x14,
	bloqmayus: 0x14,
	menu: 0x5d,
	apps: 0x5d,
	plus: 0xbb,
	mas: 0xbb,
	"+": 0xbb,
	minus: 0xbd,
	menos: 0xbd,
	"-": 0xbd,
	comma: 0xbc,
	coma: 0xbc,
	",": 0xbc,
	period: 0xbe,
	punto: 0xbe,
	".": 0xbe,
};

function normalizeKeyName(raw: string): string {
	return raw
		.normalize("NFD")
		.replace(/\p{Mn}/gu, "")
		.toLowerCase()
		.replace(/^tecla\s+/, "")
		.replace(/[\s_]+/g, "");
}

function keyCode(name: string): number | undefined {
	if (name in MODIFIERS) return MODIFIERS[name];
	if (name in NAMED) return NAMED[name];
	if (/^[a-z]$/.test(name)) return name.toUpperCase().charCodeAt(0);
	if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
	const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(name);
	if (f) return 0x6f + Number(f[1]);
	return undefined;
}

export type KeyCombo = { label: string; vks: number[] };

/**
 * "ctrl+shift+esc" → una combinación; "ctrl+a, ctrl+c" → dos seguidas.
 * Lanza un error legible si alguna tecla no se reconoce.
 */
export function parseKeySequence(input: string): KeyCombo[] {
	const combos = input
		.split(/[,;]/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (!combos.length) throw new Error("No indicaste ninguna tecla.");
	if (combos.length > 20) throw new Error("Demasiadas combinaciones seguidas (máximo 20).");
	return combos.map((combo) => {
		// "ctrl++" → la última tecla es "+".
		const trailingPlus = /\+\s*\+$/.test(combo);
		const parts = (trailingPlus ? combo.replace(/\+\s*\+$/, "") : combo).split("+").map((p) => p.trim());
		if (trailingPlus) parts.push("+");
		const vks: number[] = [];
		for (const part of parts) {
			if (!part) continue;
			const code = keyCode(part === "+" ? "+" : normalizeKeyName(part));
			if (code === undefined) {
				throw new Error(
					`No reconozco la tecla "${part}". Usa nombres como ctrl, alt, shift, win, enter, esc, tab, espacio, supr, flechas (arriba/abajo/izquierda/derecha), f1-f12, letras o números.`,
				);
			}
			if (!vks.includes(code)) vks.push(code);
		}
		if (!vks.length) throw new Error(`Combinación vacía: "${combo}".`);
		return { label: combo, vks };
	});
}
