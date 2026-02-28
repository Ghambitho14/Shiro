import { input } from "@inquirer/prompts";
import { getUserProfile, setUserProfile } from "./user-profile.js";

/**
 * Flujo para que el usuario cuente cosas sobre sí mismo.
 * Shiro no cambia de nombre; esto es solo para personalizar la experiencia.
 */
export async function runPersonalize(): Promise<void> {
	console.log("\n  ═══ Personalizar Shiro — Sobre ti ═══\n");
	console.log("  Shiro se llama siempre Shiro. Aquí configuras qué sabe de ti para ayudarte mejor.\n");

	const current = getUserProfile();

	const userName = await input({
		message: "¿Cómo te llamas? (nombre o cómo quieres que te trate)",
		default: current.userName ?? "",
	});
	if (userName.trim()) {
		setUserProfile({ userName: userName.trim() });
		console.log("  → Guardado.\n");
	}

	const language = await input({
		message: "¿En qué idioma prefieres que te hable Shiro? (ej. español, inglés)",
		default: current.language ?? "español",
	});
	if (language.trim()) {
		setUserProfile({ language: language.trim() });
		console.log("  → Guardado.\n");
	}

	const about = await input({
		message: "Cuéntale a Shiro algo sobre ti (trabajo, aficiones, lo que quieras que recuerde). Opcional.",
		default: current.about ?? "",
	});
	if (about.trim()) {
		setUserProfile({ about: about.trim() });
		console.log("  → Guardado.\n");
	}

	const extra = await input({
		message: "Algo más que Shiro deba saber? (opcional, Enter para omitir)",
		default: current.extra ?? "",
	});
	if (extra.trim()) {
		setUserProfile({ extra: extra.trim() });
		console.log("  → Guardado.\n");
	}

	const profile = getUserProfile();
	console.log("  --- Resumen ---");
	console.log(`  Cómo te llamas:  ${profile.userName || "(no definido)"}`);
	console.log(`  Idioma:          ${profile.language || "(no definido)"}`);
	console.log(`  Sobre ti:        ${profile.about ? "(definido)" : "(ninguno)"}`);
	console.log(`  Notas extra:     ${profile.extra ? "(definido)" : "(ninguna)"}`);
	console.log("  -------------\n");
	console.log("  Listo. Shiro usará esto para personalizar sus respuestas.\n");
}
