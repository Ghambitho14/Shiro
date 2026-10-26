// Markdown → HTML seguro (marked + DOMPurify + highlight.js, servidos desde /vendor).

import { icon } from "./icons.js";

let configured = false;

export function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function highlight(code, lang, enabled) {
	const hljs = window.hljs;
	if (!enabled || !hljs) return escapeHtml(code);
	try {
		if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
		if (code.length < 20000) return hljs.highlightAuto(code).value;
	} catch {}
	return escapeHtml(code);
}

let highlightEnabled = true;

function configure() {
	if (configured || !window.marked) return;
	configured = true;
	window.marked.use({
		gfm: true,
		breaks: true,
		renderer: {
			code({ text, lang }) {
				const language = String(lang || "").trim().split(/\s+/)[0].toLowerCase();
				const label = escapeHtml(language || "código");
				return `<div class="code-block"><div class="code-head"><span>${label}</span><button type="button" class="copy-code">${icon("copy", "sm")}<span>Copiar</span></button></div><pre><code class="hljs${language ? ` language-${escapeHtml(language)}` : ""}">${highlight(text, language, highlightEnabled)}</code></pre></div>`;
			},
			// Las imágenes del modelo no se cargan solas: una URL trampa podría filtrar datos
			// (p. ej. ![](https://sitio.com/?datos=...)). Se muestran como enlace.
			image({ href, text }) {
				const safeHref = /^https?:/i.test(href || "") ? href : "#";
				return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">🖼️ ${escapeHtml(text || "imagen")}</a>`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				const safeHref = /^(https?:|mailto:)/i.test(href || "") ? href : "#";
				return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ""}>${inner}</a>`;
			},
		},
	});
}

/**
 * Convierte markdown a HTML limpio. Mientras se escribe en directo (`streaming`)
 * no se colorea el código: es más rápido y evita saltos.
 */
export function renderMarkdown(text, { streaming = false } = {}) {
	configure();
	if (!window.marked || !window.DOMPurify) {
		return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
	}
	highlightEnabled = !streaming;
	const html = window.marked.parse(String(text ?? ""));
	return window.DOMPurify.sanitize(html, {
		ADD_ATTR: ["target", "rel"],
		// Nada que cargue recursos externos o parezca un formulario de verdad.
		FORBID_TAGS: ["img", "style", "form", "input", "textarea", "select", "video", "audio", "source", "picture", "iframe", "object", "embed"],
		FORBID_ATTR: ["style"],
	});
}

/** Texto plano para leer en voz alta: sin código, enlaces, símbolos ni emojis. */
export function toSpeechText(md) {
	return String(md ?? "")
		.replace(/```[\s\S]*?(```|$)/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/\|/g, " ")
		.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
		.replace(/[*_#>~]/g, "")
		.replace(/\p{Extended_Pictographic}/gu, "")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{2,}/g, "\n")
		.trim();
}
