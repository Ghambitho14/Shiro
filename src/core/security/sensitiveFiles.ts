/**
 * Archivos con claves (.env, credenciales, llaves privadas, bóvedas de contraseñas). Lo que Aku lee va al
 * modelo, y con un modelo de la nube sale del equipo: estos archivos se leen solo con permiso, también en
 * «Automático» (solo «Omitir permisos» no pregunta), y no entran en la búsqueda ni en el índice del proyecto.
 *
 * Va por nombre: un secreto dentro de un archivo con otro nombre no se detecta. La web tiene una copia de
 * esta lista en `public/js/sensitiveFiles.js` (el navegador no puede importar este archivo); una prueba
 * comprueba que las dos digan lo mismo.
 */

/** Nombres y extensiones con claves. Antes del nombre: inicio, carpeta o `:` (`git show HEAD:.env`). */
const SENSITIVE_NAME =
	/(^|[\\/:])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.(json|ya?ml|toml|ini|txt|xml|csv|conf|cfg))?|secrets?\.(json|ya?ml|toml|ini|txt|xml|env|conf|cfg|properties)|service[-_]?account[^\\/]*\.json|[^\\/]*\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk))$/i;

/** Cualquier archivo de la carpeta `.ssh` (llaves, configuración, equipos conocidos). */
const SSH_DIR = /(^|[\\/:])\.ssh[\\/]/i;

/** Plantillas de ejemplo sin claves de verdad: se leen normal. */
const EXAMPLE = /(^|[\\/:])\.env\.(example|sample|template|dist|defaults?)$/i;

/** ¿Esta ruta es de un archivo con claves? */
export function isSensitiveFile(path: string): boolean {
	const p = String(path ?? "")
		.trim()
		.replace(/^["']+|["']+$/g, "");
	if (!p || EXAMPLE.test(p)) return false;
	return SENSITIVE_NAME.test(p) || SSH_DIR.test(p);
}

/** Si un comando nombra un archivo con claves (`cat .env`, `type secrets.json`, `git diff -- .env`). */
export function mentionsSensitiveFile(command: string): boolean {
	return String(command ?? "")
		.split(/[\s|;&<>()=,]+/)
		.some((word) => isSensitiveFile(word));
}

/** Para la tarjeta de permiso: por qué se pregunta. */
export const SENSITIVE_NOTE = "archivo con claves: lo que tenga irá al modelo";
