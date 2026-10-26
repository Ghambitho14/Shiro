/**
 * API de Ajustes → Datos y del paso "¿Dónde guardo tus cosas?" de la bienvenida.
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 * La clave de Supabase nunca se envía al navegador (solo hasSupabaseKey).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_DIR, STORAGE_KINDS, setConfig, type StorageKind } from "./config/config.js";
import { migrateStorage } from "./storage/migrate.js";
import { listObsidianVaults, obsidianRoot } from "./storage/obsidian.js";
import { currentStorage, STORAGE_LABELS, testStorage, type StorageSettings } from "./storage/storage.js";
import { normalizeSupabaseUrl, SUPABASE_SQL } from "./storage/supabase.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

/**
 * Ajustes pedidos por la web. Solo se leen los campos de la opción elegida (lo escrito en las otras
 * no se ha probado y no se guarda); los vacíos mantienen lo guardado, así no hay que reescribir la clave.
 */
export function parseStorage(d: Record<string, unknown>): StorageSettings | null {
	if (!STORAGE_KINDS.includes(d.kind as StorageKind)) return null;
	const kind = d.kind as StorageKind;
	const prev = currentStorage();
	const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const next: StorageSettings = { ...prev, kind };
	if (kind === "obsidian") next.obsidianVault = text(d.obsidianVault) ?? prev.obsidianVault;
	if (kind === "supabase") {
		const url = text(d.supabaseUrl);
		next.supabaseUrl = url ? normalizeSupabaseUrl(url) : prev.supabaseUrl;
		next.supabaseKey = text(d.supabaseKey) ?? prev.supabaseKey;
	}
	return next;
}

const sameStorage = (a: StorageSettings, b: StorageSettings) =>
	a.kind === b.kind &&
	(a.kind !== "obsidian" || a.obsidianVault === b.obsidianVault) &&
	(a.kind !== "supabase" || (a.supabaseUrl === b.supabaseUrl && a.supabaseKey === b.supabaseKey));

function storagePayload() {
	const s = currentStorage();
	return {
		kind: s.kind,
		label: STORAGE_LABELS[s.kind],
		localFolder: DATA_DIR,
		obsidianVault: s.obsidianVault ?? "",
		obsidianFolder: s.obsidianVault ? obsidianRoot(s.obsidianVault) : "",
		vaults: listObsidianVaults(),
		supabaseUrl: s.supabaseUrl ?? "",
		hasSupabaseKey: Boolean(s.supabaseKey),
		sql: SUPABASE_SQL,
	};
}

export async function handleStorageApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, h: Helpers): Promise<boolean> {
	if (pathname !== "/api/storage" && pathname !== "/api/storage/test") return false;

	if (method === "GET" && pathname === "/api/storage") {
		h.sendJson(res, 200, storagePayload());
		return true;
	}

	if (method === "POST" && pathname === "/api/storage/test") {
		const next = parseStorage(await h.readJson<Record<string, unknown>>(req).catch(() => ({})));
		if (!next) return h.sendJson(res, 400, { ok: false, error: "Elige dónde guardar tus cosas." }), true;
		h.sendJson(res, 200, await testStorage(next));
		return true;
	}

	if (method === "PUT" && pathname === "/api/storage") {
		const body = await h.readJson<Record<string, unknown>>(req).catch(() => ({}) as Record<string, unknown>);
		const next = parseStorage(body);
		if (!next) return h.sendJson(res, 400, { error: "Elige dónde guardar tus cosas." }), true;
		const test = await testStorage(next);
		if (!test.ok) return h.sendJson(res, 400, { error: test.error, missingTables: test.missingTables }), true;
		const prev = currentStorage();
		let migrated = null;
		if (body.migrate === true && !sameStorage(prev, next)) {
			try {
				migrated = await migrateStorage(prev, next);
			} catch (err) {
				// No se cambia nada: lo que ya se copiara queda en el destino, pero Shiro sigue usando el sitio de antes.
				const message = err instanceof Error ? err.message : String(err);
				h.sendJson(res, 500, { error: `No pude llevar tus datos a ${STORAGE_LABELS[next.kind]}: ${message}. Sigues usando ${STORAGE_LABELS[prev.kind]}.` });
				return true;
			}
		}
		setConfig({ storage: next.kind, obsidianVault: next.obsidianVault, supabaseUrl: next.supabaseUrl, supabaseKey: next.supabaseKey });
		h.sendJson(res, 200, { ok: true, ...storagePayload(), migrated, warning: test.warning });
		return true;
	}

	return false;
}
