import { select } from "@inquirer/prompts";
import { getState } from "./store.js";

const MENU_OPTIONS = [
	{ name: "Iniciar web de chat", value: "web" },
	{ name: "Chat en terminal", value: "chat" },
	{ name: "Verificar el modelo (doctor)", value: "check" },
	{ name: "Configurar modelo", value: "provider" },
	{ name: "Salir", value: "exit" },
] as const;

function isPromptCancelled(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const withName = err as { name?: unknown; message?: unknown };
	return withName.name === "ExitPromptError"
		|| (typeof withName.message === "string" && withName.message.toLowerCase().includes("force closed"));
}

export async function runTui(): Promise<void> {
	const name = getState().name;
	console.log(`\n  Shiro — ${name}\n  Usa las flechas para moverte, Enter para elegir.\n`);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		let choice = "";
		try {
			choice = await select({
				message: "¿Qué quieres hacer?",
				choices: MENU_OPTIONS as unknown as { name: string; value: string }[],
				pageSize: 10,
			});
		} catch (err) {
			if (isPromptCancelled(err)) {
				console.log("\n  Detecté Ctrl+C. Cerrando configuración...\n");
				process.exit(0);
			}
			throw err;
		}

		switch (choice) {
			case "web":
				await import("./server.js");
				return;
			case "chat": {
				const { runChat } = await import("./chat-cli.js");
				await runChat();
				return;
			}
			case "check": {
				const { runDoctor } = await import("./doctor.js");
				await runDoctor({ fix: true });
				break;
			}
			case "provider": {
				const { runModelSetup } = await import("./modelSetup.js");
				await runModelSetup();
				break;
			}
			case "exit":
				console.log("  Hasta luego.\n");
				process.exit(0);
		}
	}
}
