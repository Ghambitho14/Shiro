/**
 * Piezas puras del navegador de Shiro: convertir lo que escribe el usuario/modelo en una URL
 * y resumir una página (texto + elementos numerados) para que el modelo la entienda.
 */

/** Resultado del script que se ejecuta dentro de la página (ver SNAPSHOT_JS). */
export type PageElement = { ref: number; kind: string; name: string; extra: string; inView: boolean };
export type PageSnapshot = {
	title: string;
	url: string;
	els: PageElement[];
	text: string;
	truncated: boolean;
	scrollY: number;
	scrollMax: number;
};

export const SNAPSHOT_MAX_ELEMENTS = 60;
export const SNAPSHOT_MAX_TEXT = 3000;

/** Nombres de este mismo equipo (127.x.x.x, ::1, 0.0.0.0, localhost; también escritos como 127.1 o ::ffff:7f00:1). */
const LOCAL_HOST = /^(localhost\.?|[\w-]+\.localhost\.?|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\])$/i;

/** true si la URL es la propia web/API de Shiro (el modelo no debe leerla desde el navegador ni con fetch_url). */
export function isShiroUrl(url: string): boolean {
	try {
		const u = new URL(url);
		// El puerto se lee cada vez: el .exe elige uno libre al arrancar.
		const shiroPort = String(Number(process.env.PORT) || 1406);
		const port = u.port || (u.protocol === "https:" ? "443" : "80");
		return LOCAL_HOST.test(u.hostname) && port === shiroPort;
	} catch {
		return false;
	}
}

/**
 * Convierte lo escrito en una URL http(s). Un texto que no parece una dirección se busca en DuckDuckGo.
 * Lanza un Error legible si es otro protocolo (file:, javascript:…) o la web de Shiro.
 */
export function normalizeUrl(input: string): string {
	const raw = input.trim();
	if (!raw) throw new Error("Indica qué web abrir.");
	let url: string;
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[\w.-]+:\d+(\/|$)/.test(raw)) {
		url = raw; // ya trae protocolo (https:, file:…)
	} else if (!/\s/.test(raw) && (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(raw) || /^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(raw))) {
		const local = /^(localhost|127\.|\[::1\])/i.test(raw);
		url = `${local ? "http" : "https"}://${raw}`;
	} else {
		return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Esa dirección no es válida: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Solo se pueden abrir direcciones web (http o https).");
	}
	if (isShiroUrl(parsed.href)) throw new Error("La web de Shiro no se abre dentro de su propio navegador.");
	return parsed.href;
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}

/** Texto para el modelo: dónde está, qué puede pulsar (con su número) y qué dice la página. */
export function formatSnapshot(s: PageSnapshot): string {
	const lines = [`Página: ${s.title || "(sin título)"}`, `URL: ${s.url}`];
	if (s.scrollMax > 40) {
		const pct = Math.round((Math.min(s.scrollY, s.scrollMax) / s.scrollMax) * 100);
		lines.push(`Posición: ${pct <= 2 ? "arriba del todo" : pct >= 98 ? "final de la página" : `${pct}% de la página`}`);
	}
	const visible = s.els.filter((e) => e.inView);
	const below = s.els.filter((e) => !e.inView);
	const fmt = (e: PageElement) => `[${e.ref}] ${e.kind}${e.name ? ` "${e.name}"` : ""}${e.extra ? ` ${e.extra}` : ""}`;
	if (s.els.length) {
		lines.push("", "Elementos (usa su número como ref para click o type):", ...visible.map(fmt));
		if (below.length) lines.push("Fuera de la vista:", ...below.map(fmt));
	} else {
		lines.push("", "No hay elementos para pulsar o escribir.");
	}
	lines.push("", "Texto que se ve:", s.text || "(la página no tiene texto visible)");
	if (s.truncated) lines.push("[Hay más texto: usa scroll con direction=down y luego read para seguir leyendo.]");
	return lines.join("\n");
}

/**
 * Script que corre dentro de la página. Va como texto (no como función) para que el
 * compilador no le añada ayudas que no existen en el navegador.
 * Marca cada elemento interactivo con data-shiro-ref="N" para poder pulsarlo luego.
 */
export const SNAPSHOT_JS = String.raw`(function (MAX_ELS, MAX_TEXT) {
	var old = document.querySelectorAll("[data-shiro-ref]");
	for (var i = 0; i < old.length; i++) old[i].removeAttribute("data-shiro-ref");
	var vw = window.innerWidth, vh = window.innerHeight;
	function clean(s, max) {
		s = String(s || "").replace(/\s+/g, " ").trim();
		return s.length > max ? s.slice(0, max - 1) + "…" : s;
	}
	var SEL = 'a[href], button, input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [contenteditable="true"], [contenteditable=""]';
	var cands = [];
	var nodes = document.querySelectorAll(SEL);
	for (var j = 0; j < nodes.length; j++) {
		var el = nodes[j];
		if (el.disabled || el.closest('[aria-hidden="true"]')) continue;
		var r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) continue;
		var st = getComputedStyle(el);
		if (st.visibility === "hidden" || st.display === "none" || parseFloat(st.opacity) === 0) continue;
		var inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
		cands.push({ el: el, top: r.top, left: r.left, inView: inView, dist: inView ? 0 : r.top >= vh ? r.top - vh : -r.bottom });
	}
	cands.sort(function (a, b) {
		if (a.inView !== b.inView) return a.inView ? -1 : 1;
		if (a.inView) return a.top - b.top || a.left - b.left;
		return a.dist - b.dist;
	});
	var ROLE = { button: "botón", link: "enlace", textbox: "campo", searchbox: "campo de búsqueda", combobox: "campo", checkbox: "casilla", radio: "opción", "switch": "interruptor", tab: "pestaña", menuitem: "menú", option: "opción" };
	var els = [];
	for (var k = 0; k < cands.length && els.length < MAX_ELS; k++) {
		var e = cands[k].el;
		var tag = e.tagName.toLowerCase();
		var type = (e.getAttribute("type") || "").toLowerCase();
		var role = e.getAttribute("role");
		var kind = role && ROLE[role] ? ROLE[role]
			: tag === "a" ? "enlace"
			: tag === "button" || tag === "summary" || type === "submit" || type === "button" || type === "reset" ? "botón"
			: tag === "select" ? "lista"
			: tag === "textarea" ? "campo"
			: tag === "input" ? (type === "checkbox" ? "casilla" : type === "radio" ? "opción" : type === "search" ? "campo de búsqueda" : "campo")
			: "editable";
		var label = e.getAttribute("aria-label") || e.getAttribute("title") || "";
		if (!label && e.labels && e.labels.length) label = e.labels[0].innerText;
		if (!label && tag === "input" && (type === "submit" || type === "button")) label = e.value;
		if (!label && (tag === "input" || tag === "textarea")) label = e.getAttribute("placeholder") || e.getAttribute("name") || "";
		if (!label) label = e.innerText || e.textContent || "";
		if (!label) {
			var img = e.querySelector("img[alt]");
			if (img) label = img.getAttribute("alt");
		}
		var extra = "";
		if (tag === "input" || tag === "textarea") {
			if (type === "checkbox" || type === "radio") extra = e.checked ? "(marcada)" : "(sin marcar)";
			else if (type === "password") extra = e.value ? "(contraseña escrita)" : "";
			else if (e.value) extra = '= "' + clean(e.value, 60) + '"';
		} else if (tag === "select") {
			var o = e.options[e.selectedIndex];
			if (o) extra = '= "' + clean(o.text, 60) + '"';
		} else if (role === "checkbox" || role === "switch") {
			extra = e.getAttribute("aria-checked") === "true" ? "(marcada)" : "(sin marcar)";
		}
		var ref = els.length + 1;
		e.setAttribute("data-shiro-ref", String(ref));
		els.push({ ref: ref, kind: kind, name: clean(label, 80), extra: extra, inView: cands[k].inView });
	}
	var BLOCK = "p,li,h1,h2,h3,h4,h5,h6,div,section,article,header,footer,nav,main,aside,td,th,tr,pre,blockquote,dd,dt,figcaption,form,fieldset,table,ul,ol";
	var text = "", lastBlock = null, truncated = false, lastSpace = false;
	var root = document.body || document.documentElement;
	var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	var started = window.scrollY < 40;
	while (walker.nextNode()) {
		var t = walker.currentNode;
		var raw = t.textContent;
		var s = raw.replace(/\s+/g, " ").trim();
		if (!s) {
			if (raw) lastSpace = true;
			continue;
		}
		var p = t.parentElement;
		if (!p || p.closest("script,style,noscript,template,svg,[hidden],[aria-hidden='true']")) continue;
		if (!p.getClientRects().length) continue;
		if (!started) {
			if (p.getBoundingClientRect().bottom <= 0) continue;
			started = true;
		}
		var block = p.closest(BLOCK);
		// Otro bloque: salto de línea. Mismo bloque: espacio solo si lo había (webs que ponen cada letra en su etiqueta).
		text += (text ? (block !== lastBlock ? "\n" : lastSpace || /^\s/.test(raw) ? " " : "") : "") + s;
		lastBlock = block;
		lastSpace = /\s$/.test(raw);
		if (text.length >= MAX_TEXT) {
			truncated = true;
			text = text.slice(0, MAX_TEXT) + "…";
			break;
		}
	}
	var de = document.documentElement;
	return {
		title: document.title || "",
		url: location.href,
		els: els,
		text: text,
		truncated: truncated,
		scrollY: Math.round(window.scrollY),
		scrollMax: Math.max(0, Math.round(de.scrollHeight - vh)),
	};
})`;
