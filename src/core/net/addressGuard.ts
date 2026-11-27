/**
 * Seguridad de direcciones para las tools que salen a internet (fetch_url, navegador).
 *
 * Evita que una web —o una instrucción escondida dentro de una página— haga que Aku lea direcciones
 * internas: los metadatos de la nube (169.254.169.254 y similares) o, por una redirección, la red
 * local del usuario. Los servidores locales que el usuario pide a propósito (localhost, LAN, LM Studio,
 * dev) siguen accesibles. En modo Hacking no se bloquea nada: alcanzar hosts internos es el objetivo.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressKind = "metadata" | "private" | "public";

/** Hosts que anuncian metadatos de la nube (devuelven credenciales): nunca se abren fuera de Hacking. */
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata.goog"]);

/** Clasifica una IPv4 literal (a.b.c.d). */
function ipv4Kind(ip: string): AddressKind {
	const p = ip.split(".").map((n) => Number(n));
	if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return "public";
	const [a, b] = p;
	if (a === 169 && b === 254) return "metadata"; // 169.254.0.0/16 (enlace local; incluye 169.254.169.254)
	if (a === 10 || a === 127 || a === 0) return "private"; // 10/8, loopback, 0.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
	if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 (CGNAT / Tailscale)
	return "public";
}

/** Clasifica una IPv6 literal (ya sin corchetes). */
function ipv6Kind(raw: string): AddressKind {
	const ip = raw.toLowerCase();
	// Mapeada o compatible con IPv4: ::ffff:a.b.c.d  o  ::a.b.c.d
	const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);
	if (mapped) return ipv4Kind(mapped[1]);
	if (ip === "::1" || ip === "::") return "private"; // loopback / sin especificar
	if (ip === "fd00:ec2::254") return "metadata"; // metadatos IPv6 de AWS
	if (/^fe[89ab]/.test(ip)) return "metadata"; // fe80::/10 (enlace local)
	if (/^f[cd]/.test(ip)) return "private"; // fc00::/7 (ULA, red privada)
	return "public";
}

/** Clasifica una dirección IP literal (v4 o v6, con o sin corchetes). Un nombre de dominio da "public". */
export function addressKind(ip: string): AddressKind {
	const host = ip.replace(/^\[|\]$/g, "");
	const v = isIP(host);
	if (v === 4) return ipv4Kind(host);
	if (v === 6) return ipv6Kind(host);
	return "public";
}

/**
 * ¿Es un host claramente peligroso (metadatos de nube / enlace local), mirando solo el literal?
 * Síncrono: para los sitios donde no se puede resolver por DNS (p. ej. validar una URL antes de abrirla).
 */
export function isDangerousHost(host: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	if (METADATA_HOSTS.has(h)) return true;
	const stripped = h.replace(/^\[|\]$/g, "");
	return isIP(stripped) !== 0 && addressKind(stripped) === "metadata";
}

/** Clasifica un host (IP o nombre); si es nombre, lo resuelve por DNS y devuelve el peor caso (evita rebinding). */
export async function classifyHost(host: string): Promise<AddressKind> {
	const h = host.toLowerCase().replace(/\.$/, "");
	if (METADATA_HOSTS.has(h)) return "metadata";
	const stripped = h.replace(/^\[|\]$/g, "");
	if (isIP(stripped) !== 0) return addressKind(stripped);
	let addrs: { address: string }[];
	try {
		addrs = await lookup(host, { all: true });
	} catch {
		return "public"; // si no resuelve, que falle la propia petición con su error normal
	}
	let worst: AddressKind = "public";
	for (const a of addrs) {
		const kind = addressKind(a.address);
		if (kind === "metadata") return "metadata";
		if (kind === "private") worst = "private";
	}
	return worst;
}

export type HostCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * ¿Se puede ir a esta URL? `hacking` = no se bloquea nada. `cameFromPublic` = venimos siguiendo una
 * redirección desde un host público; entonces un destino interno es sospechoso y se bloquea. Una
 * petición directa a la red local (cameFromPublic=false) se permite; los metadatos de nube, nunca.
 */
export async function checkUrlAllowed(url: string, opts: { cameFromPublic: boolean; hacking: boolean }): Promise<HostCheck> {
	if (opts.hacking) return { allowed: true };
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return { allowed: true }; // la URL inválida la rechaza el propio fetch con su mensaje
	}
	const kind = await classifyHost(host);
	if (kind === "metadata") {
		return { allowed: false, reason: `No abro ${host}: es una dirección de metadatos internos (nube / enlace local), un objetivo típico de robo de credenciales. Bloqueada por seguridad.` };
	}
	if (kind === "private" && opts.cameFromPublic) {
		return { allowed: false, reason: `Bloqueé por seguridad una redirección de una web pública hacia tu red interna (${host}).` };
	}
	return { allowed: true };
}
