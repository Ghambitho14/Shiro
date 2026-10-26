/**
 * Ajustes generales (`/api/settings`, `/api/state`), el modelo de Ajustes → Modelo (`/api/llm-config`,
 * `/api/llm-test`, `/api/models`) y «Sobre ti» (`/api/user-profile`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getState, setState } from "./store.js";
import { getUserProfile, setUserProfile } from "./user-profile.js";
import { getConfig, setConfig, LLM_PROVIDERS, type LLMProvider } from "./config/config.js";
import { PROVIDER_PRESETS, modelSupportsVision, resolveLLMSettings } from "./core/llm/providers.js";
import { listProviderModels } from "./core/llm/modelList.js";
import { getLLM } from "./core/llm/getLLM.js";
import { getWhatsAppBridgeStatus } from "./whatsapp.js";
import { isBodyTooLargeError, readBody, readJson, sendJson } from "./http.js";

/** Ajustes que ve la web. Nunca incluye API keys: solo si hay una guardada. */
function buildSettings() {
	const c = getConfig();
	const llm = getLLM().getConfig();
	return {
		assistantName: getState().name,
		/** Primera vez: la web muestra la bienvenida (quién eres, nombre, dónde guardar, modelo). */
		needsSetup: !c.setupDone && !getUserProfile().userName,
		storage: c.storage,
		autonomousMode: c.autonomousMode,
		approvalMode: c.approvalMode,
		execAllowlist: c.execAllowlist,
		pcControl: c.pcControl,
		vision: c.vision,
		visionActive: modelSupportsVision(llm.model, c.vision),
		platform: process.platform,
		voice: {
			sttEngine: c.sttEngine,
			sttBaseUrl: c.sttBaseUrl ?? "",
			sttModel: c.sttModel,
			hasSttApiKey: Boolean(c.sttApiKey),
			ttsEngine: c.ttsEngine,
			ttsBaseUrl: c.ttsBaseUrl ?? "",
			ttsModel: c.ttsModel,
			ttsVoice: c.ttsVoice,
			hasTtsApiKey: Boolean(c.ttsApiKey),
		},
	};
}

/**
 * Aplica los cambios de la web. Las API keys: texto = nueva clave, "" = mantener, null = borrar.
 * Los valores inválidos los descarta el schema de configuración.
 */
function applySettings(d: Record<string, unknown>): void {
	const patch: Record<string, unknown> = {};
	const copy = (keys: string[]) => {
		for (const k of keys) if (k in d && d[k] !== undefined) patch[k] = d[k];
	};
	copy(["autonomousMode", "approvalMode", "pcControl", "vision", "sttEngine", "sttModel", "ttsEngine", "ttsModel", "ttsVoice"]);
	for (const k of ["sttBaseUrl", "ttsBaseUrl"]) {
		if (typeof d[k] === "string") patch[k] = (d[k] as string).trim() || undefined;
	}
	for (const k of ["sttApiKey", "ttsApiKey"]) {
		if (d[k] === null) patch[k] = undefined;
		else if (typeof d[k] === "string" && (d[k] as string).trim()) patch[k] = (d[k] as string).trim();
	}
	if (Array.isArray(d.execAllowlist)) {
		patch.execAllowlist = d.execAllowlist.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
	}
	if (typeof d.setupDone === "boolean") patch.setupDone = d.setupDone;
	if (Object.keys(patch).length) setConfig(patch as Partial<ReturnType<typeof getConfig>>);
	if (typeof d.assistantName === "string" && d.assistantName.trim()) setState({ name: d.assistantName.trim().slice(0, 40) });
}

export async function handleSettingsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
	if (method === "GET" && pathname === "/api/state") {
		const state = getState();
		const vllm = getLLM().getConfig();
		const config = getConfig();
		const waStatus = getWhatsAppBridgeStatus();
		const waQr = waStatus.qr ? await (await import("qrcode")).toDataURL(waStatus.qr, { margin: 1, width: 280 }) : null;
		sendJson(res, 200, {
			name: state.name,
			vllm,
			abilities: config.abilities ?? null,
			autonomousMode: config.autonomousMode ?? true,
			whatsapp: { ...waStatus, qrDataUrl: waQr },
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/llm-config") {
		const s = resolveLLMSettings();
		sendJson(res, 200, {
			provider: s.provider,
			model: s.model,
			baseUrl: s.baseUrl,
			hasApiKey: Boolean(s.apiKey),
			providers: LLM_PROVIDERS.map((p) => ({
				value: p,
				label: PROVIDER_PRESETS[p].label,
				title: PROVIDER_PRESETS[p].title,
				hint: PROVIDER_PRESETS[p].hint,
				group: PROVIDER_PRESETS[p].group,
				baseUrl: PROVIDER_PRESETS[p].baseUrl,
				model: PROVIDER_PRESETS[p].model,
				local: PROVIDER_PRESETS[p].local,
				needsApiKey: PROVIDER_PRESETS[p].needsApiKey,
				keyUrl: PROVIDER_PRESETS[p].keyUrl ?? "",
				managed: Boolean(PROVIDER_PRESETS[p].managed),
			})),
		});
		return true;
	}

	if (method === "PUT" && pathname === "/api/llm-config") {
		let data: { provider?: string; model?: string; baseUrl?: string; apiKey?: string };
		try {
			data = JSON.parse(await readBody(req));
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		if (!data.provider || !(LLM_PROVIDERS as readonly string[]).includes(data.provider)) {
			sendJson(res, 400, { error: "Proveedor inválido" });
			return true;
		}
		const provider = data.provider as LLMProvider;
		const preset = PROVIDER_PRESETS[provider];
		const baseUrl = data.baseUrl?.trim();
		const model = data.model?.trim();
		setConfig({
			llmProvider: provider,
			// llama.cpp integrado: la dirección la pone Shiro al abrirlo.
			llmBaseUrl: !preset.managed && baseUrl && baseUrl !== preset.baseUrl ? baseUrl : undefined,
			llmModel: model && model !== preset.model ? model : undefined,
			// Vacío = mantener la key actual (el navegador nunca la recibe), salvo al cambiar de proveedor.
			...(data.apiKey?.trim()
				? { llmApiKey: data.apiKey.trim() }
				: provider !== getConfig().llmProvider
					? { llmApiKey: undefined }
					: {}),
		});
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/llm-test") {
		try {
			const t0 = Date.now();
			const reply = await getLLM().chat([{ role: "user", content: "Responde solo: ok" }]);
			sendJson(res, 200, { ok: true, reply: reply.slice(0, 200), ms: Date.now() - t0 });
		} catch (err) {
			sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	// === AJUSTES (lo que se cambia desde la ventana de Ajustes de la web) ===
	if (method === "GET" && pathname === "/api/settings") {
		sendJson(res, 200, buildSettings());
		return true;
	}

	if (method === "PUT" && pathname === "/api/settings") {
		let data: Record<string, unknown>;
		try {
			data = await readJson<Record<string, unknown>>(req);
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		try {
			applySettings(data);
			sendJson(res, 200, buildSettings());
		} catch (err) {
			sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		return true;
	}

	// === MODELOS DISPONIBLES en el proveedor actual (para el selector rápido) ===
	if (method === "GET" && pathname === "/api/models") {
		const s = resolveLLMSettings();
		const list = await listProviderModels({ provider: s.provider });
		sendJson(res, 200, {
			provider: s.provider,
			current: s.model,
			models: list.models.map((m) => m.id),
			...(list.error ? { error: `No pude pedir la lista de modelos: ${list.error}` } : {}),
		});
		return true;
	}

	// === MODELOS de un proveedor del formulario de Ajustes → Modelo (aún sin guardar) ===
	if (method === "POST" && pathname === "/api/models") {
		let data: { provider?: string; baseUrl?: string; apiKey?: string };
		try {
			data = await readJson<typeof data>(req);
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		if (!data.provider || !(LLM_PROVIDERS as readonly string[]).includes(data.provider)) {
			sendJson(res, 400, { error: "Proveedor inválido" });
			return true;
		}
		sendJson(
			res,
			200,
			await listProviderModels({
				provider: data.provider as LLMProvider,
				baseUrl: typeof data.baseUrl === "string" ? data.baseUrl : undefined,
				apiKey: typeof data.apiKey === "string" ? data.apiKey : undefined,
			}),
		);
		return true;
	}

	if (method === "GET" && pathname === "/api/user-profile") {
		sendJson(res, 200, getUserProfile());
		return true;
	}

	if (method === "PUT" && pathname === "/api/user-profile") {
		let body = "";
		try {
			body = await readBody(req);
		} catch (err) {
			if (isBodyTooLargeError(err)) {
				sendJson(res, 413, { error: "Request body too large (max 6 MB)" });
				return true;
			}
			sendJson(res, 400, { error: "Invalid body" });
			return true;
		}
		let payload: Record<string, unknown> = {};
		try {
			if (body.trim()) payload = JSON.parse(body) as Record<string, unknown>;
		} catch {
			sendJson(res, 400, { error: "Invalid JSON" });
			return true;
		}
		const next = setUserProfile({
			userName: typeof payload.userName === "string" ? payload.userName : undefined,
			language: typeof payload.language === "string" ? payload.language : undefined,
			about: typeof payload.about === "string" ? payload.about : undefined,
			extra: typeof payload.extra === "string" ? payload.extra : undefined,
		});
		sendJson(res, 200, next);
		return true;
	}
	return false;
}
