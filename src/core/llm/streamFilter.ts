/**
 * Filtro para texto en streaming: oculta bloques que el usuario no debe ver
 * (<think>…</think> de modelos razonadores y <tool_call>…</tool_call> del modo texto),
 * aunque las etiquetas lleguen partidas entre varios trozos.
 */
const HIDDEN_TAGS = ["think", "tool_call"];

export class StreamFilter {
	private buf = "";
	private inside: string | null = null;

	constructor(private readonly emit: (text: string) => void) {}

	push(chunk: string): void {
		this.buf += chunk;
		this.drain();
	}

	/** Emite lo que quede pendiente (si no estamos dentro de un bloque oculto). */
	flush(): void {
		if (!this.inside && this.buf) this.emit(this.buf);
		this.buf = "";
	}

	private drain(): void {
		while (this.buf) {
			if (this.inside) {
				const close = `</${this.inside}>`;
				const end = this.buf.indexOf(close);
				if (end < 0) {
					// Conservar solo lo que podría ser el inicio de la etiqueta de cierre.
					this.buf = this.buf.slice(-(close.length - 1));
					return;
				}
				this.buf = this.buf.slice(end + close.length);
				this.inside = null;
				continue;
			}
			const lt = this.buf.indexOf("<");
			if (lt < 0) {
				this.emit(this.buf);
				this.buf = "";
				return;
			}
			if (lt > 0) {
				this.emit(this.buf.slice(0, lt));
				this.buf = this.buf.slice(lt);
			}
			const opened = HIDDEN_TAGS.find((t) => this.buf.startsWith(`<${t}>`));
			if (opened) {
				this.inside = opened;
				this.buf = this.buf.slice(opened.length + 2);
				continue;
			}
			const couldBeTag = HIDDEN_TAGS.some((t) => `<${t}>`.startsWith(this.buf));
			if (couldBeTag) return; // esperar más texto
			this.emit("<");
			this.buf = this.buf.slice(1);
		}
	}
}
