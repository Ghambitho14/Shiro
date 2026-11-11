/**
 * Que el modelo compruebe su trabajo: si en Code cambió archivos del proyecto y va a terminar sin
 * haber ejecutado nada después, se le recuerda una vez que corra la comprobación del proyecto
 * (los comandos salen de folderInfo). Solo es un aviso: el comando sigue pidiendo permiso.
 */

/** Cambiar solo notas o documentación no necesita comprobación. */
const DOCS = /\.(md|mdx|txt|rst|adoc)$/i;
/** Herramientas que ejecutan algo: después de usarlas se da por comprobado. */
const RUNNERS = new Set(["exec", "claude_code"]);

export type SelfCheck = {
	/** Apunta cada herramienta que termina. */
	note: (name: string, args: Record<string, unknown>, ok: boolean) => void;
	/** La nota para el modelo si cambió código y no lo comprobó; undefined si no hace falta. */
	pending: () => string | undefined;
};

export function createSelfCheck(commands: readonly string[]): SelfCheck {
	const edited = new Set<string>();
	return {
		note(name, args, ok) {
			if (name === "project" && (args.action === "edit" || args.action === "write")) {
				const path = typeof args.path === "string" ? args.path.trim() : "";
				if (ok && path && !DOCS.test(path)) edited.add(path);
				return;
			}
			// Aunque el comando falle, ya vio su salida: le toca arreglarlo, no repetir el aviso.
			if (RUNNERS.has(name) || (name === "terminal" && args.action === "run")) edited.clear();
		},
		pending() {
			if (!edited.size || !commands.length) return undefined;
			const files = [...edited].slice(0, 5).join(", ") + (edited.size > 5 ? "…" : "");
			edited.clear();
			return `[Nota del sistema; no la escribió el usuario] Cambiaste ${files} y no ejecutaste ninguna comprobación. Antes de terminar corre en la terminal la del proyecto (${commands.slice(0, 3).join(", ")}) y lee su salida; si falla por tu cambio, arréglalo. Si el usuario no da permiso o de verdad no hay nada que comprobar, dilo en una línea, sin afirmar que funciona.`;
		},
	};
}
