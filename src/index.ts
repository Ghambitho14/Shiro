import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getState, setState } from "./store.js";

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
${name} v${pkg.version}

Comandos:
  npm run tui       Chat en terminal (recomendado)
  npm run dev       Servidor web
  npm run wa        WhatsApp Web
  npm run config    Configuración (modelo, conexión)
  npm run doctor    Comprobar que el modelo funciona
  npm run mcp       Servidor MCP (para OpenCode, Claude Code...)
  npm run onboard   Primera configuración
  npm run test      Tests

Más info en: README.md
`.trim();
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
		console.log(buildHelp());
		return;
	}

	if (arg === "tui") {
		const { runChat } = await import("./chat-cli.js");
		await runChat();
		return;
	}

	if (arg === "doctor") {
		const { runDoctor } = await import("./doctor.js");
		const healthy = await runDoctor({ fix: argv.includes("--fix") });
		if (!healthy) process.exitCode = 1;
		return;
	}

	if (arg === "mcp") {
		// En MCP por stdio, stdout es del protocolo: cualquier console.log lo rompería.
		console.log = console.error;
		console.info = console.error;
		const { runMcpServer } = await import("./mcp/server.js");
		await runMcpServer();
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

	if (arg === "web" || arg === "server") {
		if (isFirstRun()) {
			console.log("\n  Primera vez: ejecuta 'npm run onboard' para configurar.\n");
			return;
		}
		await import("./server.js");
		return;
	}

	if (arg === "wa" || arg === "whatsapp") {
		const { runWhatsAppBridge } = await import("./whatsapp.js");
		await runWhatsAppBridge();
		return;
	}

	if (arg === "--version" || arg === "-v") {
		console.log(pkg.version);
		return;
	}

	if (arg === "set-name") {
		const name = argv[1]?.trim();
		if (!name) {
			console.error("Uso: npm start -- set-name <nombre>");
			process.exitCode = 1;
			return;
		}
		setState({ name });
		console.log(`Nombre guardado: ${getState().name}`);
		return;
	}

	console.log(buildHelp());
}

void main();
