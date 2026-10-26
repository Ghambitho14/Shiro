import { getState } from "./store.js";
import { APP_VERSION, IS_EXE } from "./runtime.js";

/** Comandos antiguos: todo lo que hacían ahora está en Ajustes de la ventana. */
const REMOVED = new Set(["config", "onboard", "personalize", "set-name"]);

function buildHelp(): string {
	const name = getState().name;
	if (IS_EXE) return buildExeHelp(name);
	return `
${name} v${APP_VERSION}

Usar ${name}:
  npm start          Abre ${name} en su propia ventana (igual que npm run app)
  npm run app        Lo mismo; con "-- --acceso-directo" crea un icono en el escritorio
  npm run dev        Solo el servidor web (ábrelo en http://127.0.0.1:1406)
  npm run tui        Chat en la terminal
  npm run wa         Puente de WhatsApp

Herramientas:
  npm run doctor     Comprueba que el modelo responde ("-- --fix" aplica lo recomendado)
  npm run mcp        ${name} como servidor MCP (para OpenCode, Claude Code, Cursor...)
  npm test           Pruebas
  npm run check      Revisión de tipos

La configuración (modelo, voz, control del PC, habilidades, MCP...) está en
la ventana de ${name}: Ajustes, abajo a la izquierda.

En el chat escribe /ayuda para ver los comandos (/modelo, /habilidades, /mcp...).
`.trim();
}

/** Ayuda de Shiro.exe (sin npm ni código fuente). */
function buildExeHelp(name: string): string {
	return `
${name} v${APP_VERSION}

  Shiro.exe                    Abre ${name} en su propia ventana (doble clic)
  Shiro.exe --acceso-directo   Lo mismo y crea un icono en el escritorio
  Shiro.exe web                Solo el servidor web (http://127.0.0.1:1406)
  Shiro.exe tui                Chat en la terminal
  Shiro.exe wa                 Puente de WhatsApp
  Shiro.exe doctor             Comprueba que el modelo responde
  Shiro.exe mcp                ${name} como servidor MCP (OpenCode, Claude Code, Cursor...)

La configuración está en la ventana de ${name}: Ajustes, abajo a la izquierda.
`.trim();
}

async function main(): Promise<void> {
	let argv = process.argv.slice(2);
	if (argv[0] === "--") argv = argv.slice(1);
	// Shiro.exe con doble clic (o solo con opciones como --acceso-directo): abre la ventana.
	if (IS_EXE && (!argv[0] || argv[0].startsWith("--acceso") || argv[0] === "--shortcut")) argv = ["app", ...argv];
	if (IS_EXE) process.title = "Shiro";
	const arg = argv[0];

	if (!arg || arg === "--help" || arg === "-h" || arg === "ayuda" || arg === "help") {
		console.log(buildHelp());
		return;
	}

	if (arg === "--version" || arg === "-v") {
		console.log(APP_VERSION);
		return;
	}

	if (arg === "app") {
		const { runApp } = await import("./app.js");
		await runApp(argv.slice(1));
		return;
	}

	if (arg === "web" || arg === "server") {
		await import("./server.js");
		return;
	}

	if (arg === "tui") {
		const { runChat } = await import("./chat-cli.js");
		await runChat();
		return;
	}

	if (arg === "wa" || arg === "whatsapp") {
		const { runWhatsAppBridge } = await import("./whatsapp.js");
		await runWhatsAppBridge();
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

	if (REMOVED.has(arg)) {
		console.log(`\n  "${arg}" ya no existe: ahora todo se configura en la ventana de Shiro.`);
		console.log(`  Ábrela con: ${IS_EXE ? "Shiro.exe" : "npm start"}   → Ajustes (abajo a la izquierda)\n`);
		process.exitCode = 1;
		return;
	}

	console.log(`Comando desconocido: ${arg}\n`);
	console.log(buildHelp());
	process.exitCode = 1;
}

void main();
