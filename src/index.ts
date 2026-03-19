import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState, setState } from "./store.js";
import { greet } from "./greet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string; name: string };

const DATA_DIR = join(__dirname, "..", "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");

function isFirstRun(): boolean {
	return !existsSync(CONFIG_FILE);
}

function buildHelp(): string {
	const name = getState().name;
	return `
${name} — ${pkg.name} v${pkg.version}

Uso:
  pnpm tui                Hablar con el asistente en terminal
  pnpm run config         Entrar a configuraciones (menú TUI)
  pnpm onboard            Configuración inicial (primera vez)
  pnpm run dev            Iniciar la web de chat
  pnpm start server       Iniciar solo el servidor web
  pnpm wa                 Iniciar puente WhatsApp Web (QR)
  pnpm personalize       Qué saber de ti (para personalizar Shiro)
  --help / --version     Ayuda o versión
`.trim();
}

function buildShiroHelp(): string {
	return `
Comandos:
  pnpm tui                Chat con el asistente en terminal
  pnpm run config         Configuraciones (modelo, vLLM, etc.)
  pnpm onboard            Configuración inicial (primera vez)
  pnpm personalize        Qué saber de ti (personalizar Shiro)
  pnpm run dev            Iniciar la web de chat
  pnpm start server       Iniciar solo el servidor web
  pnpm wa                 Iniciar puente WhatsApp Web (QR)
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
		console.log(buildShiroHelp());
		return;
	}
	if (arg === "tui") {
		const { runTuiChat } = await import("./tui-chat.js");
		await runTuiChat();
		return;
	}
	if (arg === "tui2" || arg === "opencode") {
		const { runShiroTUI } = await import("./tui-opencode.js");
		runShiroTUI();
		return;
	}
	if (arg === "config") {
		const { runTui } = await import("./tui.js");
		await runTui();
		return;
	}
	if (arg === "onboard") {
		const { runOnboard } = await import("./onboard.js");
		await runOnboard();
		return;
	}
	if (arg === "personalize") {
		const { runPersonalize } = await import("./personalize.js");
		await runPersonalize();
		return;
	}
	if (arg === "serve" || arg === "web" || arg === "server") {
		if (isFirstRun()) {
			console.log("\n  Primera vez: ejecuta 'pnpm shiro onboard' para configurar.\n");
			return;
		}
		await import("./server.js");
		return;
	}
	if (arg === "whatsapp" || arg === "wa") {
		const { runWhatsAppBridge } = await import("./whatsapp.js");
		await runWhatsAppBridge();
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

	// Comando desconocido: comportamiento por defecto
	run();
}

void main();
