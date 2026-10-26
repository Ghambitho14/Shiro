/**
 * Supabase como almacén: chats, recuerdos, recordatorios y notas de memoria en tablas shiro_* (API REST de PostgREST).
 * Se usa la clave secreta (service_role / sb_secret_…). Las tablas tienen RLS activado y ninguna
 * política, así que con la clave pública nadie puede leerlas. La clave nunca va al navegador.
 */

export type SupabaseConfig = { url: string; key: string };

/** SQL que el usuario pega en el editor SQL de Supabase (se puede ejecutar varias veces). */
export const SUPABASE_SQL = `-- Tablas de Shiro (se puede ejecutar varias veces sin problema)
create table if not exists shiro_chats (
  id text primary key,
  title text not null,
  created_at bigint not null,
  updated_at bigint not null,
  last_preview text not null default '',
  messages jsonb not null default '[]'::jsonb
);
create index if not exists shiro_chats_updated_at on shiro_chats (updated_at desc);

create table if not exists shiro_chat_links (
  channel text not null,
  external_id text not null,
  session_id text not null references shiro_chats (id) on delete cascade,
  primary key (channel, external_id)
);

create table if not exists shiro_memories (
  id text primary key,
  content text not null,
  type text not null default 'observation',
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  embedding jsonb
);

create table if not exists shiro_reminders (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists shiro_notes (
  path text primary key,
  content text not null,
  updated_at bigint not null
);

-- Solo la clave secreta (service_role) puede leerlas: sin políticas, la clave pública no ve nada.
alter table shiro_chats enable row level security;
alter table shiro_chat_links enable row level security;
alter table shiro_memories enable row level security;
alter table shiro_reminders enable row level security;
alter table shiro_notes enable row level security;
`;

export const SUPABASE_TABLES = ["shiro_chats", "shiro_chat_links", "shiro_memories", "shiro_reminders", "shiro_notes"] as const;

export class SupabaseError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly missingTables = false,
	) {
		super(message);
		this.name = "SupabaseError";
	}
}

/** Deja la URL del proyecto sin barra final ni la ruta /rest/v1 si la pegaron entera. */
export function normalizeSupabaseUrl(raw: string): string {
	return raw.trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

/** Si la clave es la pública (anon / sb_publishable_), explica por qué no sirve. */
export function supabaseKeyProblem(key: string): string | null {
	const k = key.trim();
	if (!k) return "Falta la clave de Supabase.";
	const publicKey = "Esa es la clave pública de Supabase. Usa la clave secreta (service_role o sb_secret_…): Supabase → Project Settings → API Keys.";
	if (k.startsWith("sb_publishable_")) return publicKey;
	if (k.startsWith("eyJ")) {
		try {
			const payload = JSON.parse(Buffer.from(k.split(".")[1] ?? "", "base64url").toString("utf-8")) as { role?: string };
			if (payload.role === "anon") return publicKey;
		} catch {
			// no es un JWT legible: que lo diga Supabase
		}
	}
	return null;
}

function describeError(status: number, info: { message?: string; code?: string; hint?: string }, url: string): SupabaseError {
	const msg = info.message ?? "";
	if (info.code === "PGRST205" || info.code === "42P01" || /could not find the table|relation .* does not exist/i.test(msg)) {
		return new SupabaseError(status, "Faltan las tablas de Shiro en Supabase: copia el SQL de Ajustes → Datos, pégalo en Supabase → SQL Editor y pulsa Run.", true);
	}
	if (status === 401 || info.code === "PGRST301" || /invalid api key|jwt/i.test(msg)) {
		return new SupabaseError(status, "Supabase rechazó la clave. Copia de nuevo la clave secreta (service_role o sb_secret_…) del proyecto.");
	}
	if (info.code === "42501" || /row-level security|permission denied/i.test(msg)) {
		return new SupabaseError(status, "Supabase no deja usar las tablas con esa clave. Usa la clave secreta (service_role), no la pública.");
	}
	if (status === 404) return new SupabaseError(status, `No encontré la API de Supabase en ${url}. Revisa la dirección del proyecto (https://xxxx.supabase.co).`);
	return new SupabaseError(status, `Supabase respondió ${status}${msg ? `: ${msg}` : ""}`);
}

/** "fetch failed" traducido a algo que se entienda. */
function connectionProblem(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	if (err.name === "TimeoutError" || err.name === "AbortError") return "no respondió a tiempo";
	const cause = err.cause as { code?: string; errors?: { code?: string }[] } | undefined;
	const code = cause?.code ?? cause?.errors?.[0]?.code ?? "";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "esa dirección no existe o no hay internet";
	if (code === "ECONNREFUSED") return "el servidor rechazó la conexión";
	if (code.startsWith("CERT_") || code.includes("TLS") || code.includes("SSL")) return "hay un problema con el certificado HTTPS";
	return err.message === "fetch failed" ? "no responde" : err.message;
}

/** Una petición a la API REST (PostgREST). `path` es "tabla?filtros". */
export async function supabaseRequest<T>(
	cfg: SupabaseConfig,
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	opts: { body?: unknown; prefer?: string; timeoutMs?: number } = {},
): Promise<T> {
	const base = normalizeSupabaseUrl(cfg.url);
	const headers: Record<string, string> = { apikey: cfg.key, Accept: "application/json" };
	// Las claves antiguas son JWT y van también como Bearer; las nuevas (sb_…) solo en apikey.
	if (cfg.key.startsWith("eyJ")) headers.Authorization = `Bearer ${cfg.key}`;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	if (opts.prefer) headers.Prefer = opts.prefer;
	let res: Response;
	try {
		res = await fetch(`${base}/rest/v1/${path}`, {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
		});
	} catch (err) {
		throw new SupabaseError(0, `No pude conectar con Supabase (${base}): ${connectionProblem(err)}. Revisa la dirección y tu conexión a internet.`);
	}
	const text = await res.text();
	if (!res.ok) {
		let info: { message?: string; code?: string; hint?: string } = {};
		try {
			info = JSON.parse(text) as typeof info;
		} catch {
			info = { message: text.slice(0, 200) };
		}
		throw describeError(res.status, info, base);
	}
	return (text ? JSON.parse(text) : undefined) as T;
}

/** `eq.valor` codificado para una URL de PostgREST. */
export const eq = (value: string) => `eq.${encodeURIComponent(value)}`;

/** `in.("a","b")` codificado (los ids se escapan entre comillas). */
export const inList = (values: string[]) => `in.(${values.map((v) => encodeURIComponent(`"${v.replace(/"/g, '\\"')}"`)).join(",")})`;

/** Comprueba la clave y que existen las tablas. */
export async function testSupabase(cfg: SupabaseConfig): Promise<{ ok: true } | { ok: false; error: string; missingTables?: boolean }> {
	const problem = supabaseKeyProblem(cfg.key);
	if (problem) return { ok: false, error: problem };
	try {
		new URL(normalizeSupabaseUrl(cfg.url));
	} catch {
		return { ok: false, error: "La dirección de Supabase no es válida (ejemplo: https://xxxx.supabase.co)." };
	}
	try {
		for (const table of SUPABASE_TABLES) await supabaseRequest(cfg, "GET", `${table}?select=*&limit=1`);
		return { ok: true };
	} catch (err) {
		const e = err instanceof SupabaseError ? err : new SupabaseError(0, String(err));
		return { ok: false, error: e.message, missingTables: e.missingTables || undefined };
	}
}
