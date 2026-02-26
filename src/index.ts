import { createRequire } from "node:module";
import { getState, setState } from "./store.js";
import { greet } from "./greet.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; name: string };

function buildHelp(): string {
	const name = getState().name;
	return `
${name} — ${pkg.name} v${pkg.version}

El nombre del asistente lo puedes cambiar con: pnpm start set-name <nombre>
(lo puede invocar también el agente "que aprende de sí mismo").

Uso:
  pnpm start              Inicia la web de chat (servidor + vLLM)
  pnpm start config       Terminal interactiva (TUI): menú con flechas para config y más
  pnpm start greet        Saluda
  pnpm start greet <nombre>  Saluda por nombre
  pnpm start set-name <nombre>  Guarda el nombre del asistente
  pnpm start --help       Muestra esta ayuda
  pnpm start --version    Muestra la versión
`.trim();
}

function run(): void {
	const name = getState().name;
	console.log(`${name} (base en construccion)\n`);
}

async function main(): Promise<void> {
	let argv = process.argv.slice(2);
	if (argv[0] === "--") argv = argv.slice(1);
	const arg = argv[0];

	if (arg === "--help" || arg === "-h") {
		console.log(buildHelp());
		return;
	}
	if (!arg) {
		await import("./server.js");
		return;
	}
	if (arg === "--version" || arg === "-v") {
		console.log(pkg.version);
		return;
	}
	if (arg === "greet") {
		greet(argv[1]);
		return;
	}
	if (arg === "set-name") {
		const name = argv[1]?.trim();
		if (!name) {
			console.error("Uso: pnpm start set-name <nombre>");
			process.exitCode = 1;
			return;
		}
		setState({ name });
		console.log(`Nombre guardado: ${getState().name}`);
		return;
	}

	if (arg === "config") {
		const { runTui } = await import("./tui.js");
		await runTui();
		return;
	}

	// Comando desconocido: comportamiento por defecto
	run();
}

void main();
