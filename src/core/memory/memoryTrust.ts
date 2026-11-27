/**
 * Detector sencillo de inyección de instrucciones (idea de OpenJarvis): frases típicas con que un texto de afuera
 * intenta darle órdenes al modelo. Lo usa la memoria automática para no guardar (o guardar en cuarentena) lo que
 * parezca una orden escondida. Va por palabras, así que no es infalible: es una barrera más, no la única
 * (la cuarentena ya se pone sola cuando la respuesta leyó contenido de afuera).
 */

const INJECTION_PATTERNS: RegExp[] = [
	// «ignora las instrucciones anteriores», «olvida todo lo anterior», «haz caso omiso de tus reglas»
	/\b(ignora|ignor[aá]|ignoren|olvida|olvid[aá]|olviden|descarta|desobedece)\b[^.\n]{0,40}\b(instrucci[oó]n|instrucciones|indicaciones|reglas|[oó]rdenes|lo anterior|todo lo que)/i,
	/\bhaz caso omiso\b/i,
	/\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|messages?)/i,
	// «a partir de ahora eres…», «you are now…»
	/\b(a partir de ahora|desde ahora|ahora)\s+(eres|ser[aá]s|act[uú]as)\b/i,
	/\byou are now\b|\bfrom now on,? you\b/i,
	/\b(nuevas instrucciones|new instructions|system prompt|prompt del sistema|developer message|mensaje del sistema)\b/i,
	// Que el usuario no se entere
	/\b(no (se lo )?(le )?digas al usuario|sin que el usuario (lo )?sepa|don'?t tell the user|without telling the user)\b/i,
	// Marcas de formato de chat o de herramientas metidas en un texto
	/<\/?(tool_call|system|assistant)>|<\|im_(start|end)\|>|\[\/?INST\]|<<<\s*(fin\s+del\s+)?contenido\s+externo/i,
];

/** Si el texto parece traer órdenes para el modelo. */
export function looksLikeInjection(text: string): boolean {
	return INJECTION_PATTERNS.some((p) => p.test(text));
}
