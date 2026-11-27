/**
 * Archivos con claves (.env, credenciales, llaves privadas…): no se adjuntan ni se suben a un proyecto.
 * Copia de `src/core/security/sensitiveFiles.ts` (el navegador no puede importar el código del servidor);
 * `sensitiveFiles.test.ts` comprueba que las dos digan lo mismo. Si cambias una, cambia la otra.
 */

const SENSITIVE_NAME =
	/(^|[\\/:])(\.env(\.[^\\/]*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.(json|ya?ml|toml|ini|txt|xml|csv|conf|cfg))?|secrets?\.(json|ya?ml|toml|ini|txt|xml|env|conf|cfg|properties)|service[-_]?account[^\\/]*\.json|[^\\/]*\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk))$/i;
const SSH_DIR = /(^|[\\/:])\.ssh[\\/]/i;
const EXAMPLE = /(^|[\\/:])\.env\.(example|sample|template|dist|defaults?)$/i;

/** ¿Esta ruta es de un archivo con claves? */
export function isSensitiveFile(path) {
	const p = String(path ?? "")
		.trim()
		.replace(/^["']+|["']+$/g, "");
	if (!p || EXAMPLE.test(p)) return false;
	return SENSITIVE_NAME.test(p) || SSH_DIR.test(p);
}
