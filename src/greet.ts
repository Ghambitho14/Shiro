/**
 * Comando greet: saluda al usuario (opcionalmente por nombre).
 */
export function greet(name?: string): void {
	if (name) {
		console.log(`Hola, ${name}!`);
	} else {
		console.log("Hola!");
	}
}
