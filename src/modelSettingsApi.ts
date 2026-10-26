/**
 * API de Ajustes → Modelo → "Ajustes de <modelo>": cómo responde, contexto, rendimiento de
 * llama.cpp y herramientas, para un modelo concreto o para todos (los generales).
 * server.ts la llama antes de sus propias rutas; devuelve true si atendió la petición.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { LLM_PROVIDERS, getConfig, type LLMProvider } from "./config/config.js";
import { getEngineStatus } from "./core/llamacpp/engine.js";
import { PROVIDER_PRESETS, resolveLLMSettings } from "./core/llm/providers.js";
import { generalTuning, getModelTuning, ownTuning, parseTuningInput, setGeneralTuning, setModelTuning } from "./core/llm/modelSettings.js";

type Helpers = {
	readJson: <T>(req: IncomingMessage) => Promise<T>;
	sendJson: (res: ServerResponse, status: number, data: object) => void;
};

/** Qué ajustes tienen sentido con cada proveedor. */
export function tuningFields(provider: LLMProvider) {
	const p = PROVIDER_PRESETS[provider];
	return {
		/** "Pensar antes de responder" solo se puede pedir a modelos locales. */
		thinking: p.local,
		/** llama: Automático o tamaño; ollama: num_ctx; note: se elige en la otra app; null: nube. */
		context: p.managed ? "llama" : p.dialect === "ollama" ? "ollama" : p.local ? "note" : null,
		performance: Boolean(p.managed),
	} as const;
}

/** LM Studio dice con qué contexto tiene cargado el modelo (API REST /api/v0). Si no responde, nada. */
async function lmStudioContext(baseUrl: string, model: string): Promise<number | undefined> {
	try {
		const root = baseUrl.replace(/\/v1$/, "");
		const r = await fetch(`${root}/api/v0/models`, { signal: AbortSignal.timeout(1500) });
		if (!r.ok) return undefined;
		const j = (await r.json()) as { data?: { id?: string; loaded_context_length?: number; max_context_length?: number }[] };
		const m = j.data?.find((x) => x.id === model);
		const n = m?.loaded_context_length ?? m?.max_context_length;
		return typeof n === "number" && n > 0 ? n : undefined;
	} catch {
		return undefined;
	}
}

async function buildPayload(provider: LLMProvider, model: string) {
	const p = PROVIDER_PRESETS[provider];
	const fields = tuningFields(provider);
	let contextNow: number | undefined;
	let contextNote: string | undefined;
	if (fields.context === "llama") {
		const status = await getEngineStatus();
		if (status && status.modelId.toLowerCase() === model.toLowerCase()) contextNow = status.ctx;
	} else if (fields.context === "note") {
		const s = resolveLLMSettings();
		if (provider === "lmstudio" && s.provider === "lmstudio") contextNow = await lmStudioContext(s.baseUrl, model);
		contextNote = `El tamaño de contexto se elige en ${p.label.replace(/ \(.*\)$/, "")} al cargar el modelo.`;
	}
	return {
		provider,
		model,
		providerLabel: p.label,
		fields,
		general: generalTuning(provider),
		own: ownTuning(provider, model),
		effective: getModelTuning(provider, model),
		contextNow,
		contextNote,
	};
}

/** Proveedor y modelo de la petición (o los activos). */
function target(params: URLSearchParams | Record<string, unknown>): { provider: LLMProvider; model: string } | string {
	const get = (k: string) => (params instanceof URLSearchParams ? params.get(k) : params[k]);
	const active = resolveLLMSettings();
	const provider = String(get("provider") ?? "") || active.provider;
	if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) return "Proveedor inválido";
	const model = String(get("model") ?? "").trim() || (provider === active.provider ? active.model : "");
	if (!model) return "Falta el modelo";
	if (model.length > 300) return "Nombre de modelo demasiado largo";
	return { provider: provider as LLMProvider, model };
}

export async function handleModelSettingsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, { readJson, sendJson }: Helpers): Promise<boolean> {
	if (pathname !== "/api/model-settings") return false;
	const reply = (status: number, data: object) => {
		sendJson(res, status, data);
		return true;
	};
	const fail = (status: number, err: unknown) => reply(status, { error: err instanceof Error ? err.message : String(err) });
	const params = new URL(req.url ?? "/", "http://x").searchParams;

	if (method === "GET" || method === "DELETE") {
		const t = target(params);
		if (typeof t === "string") return fail(400, t);
		// DELETE: "Volver a los generales" (borra los ajustes propios del modelo).
		if (method === "DELETE") setModelTuning(t.provider, t.model, null);
		return reply(200, await buildPayload(t.provider, t.model));
	}

	if (method === "PUT") {
		let d: Record<string, unknown>;
		try {
			d = await readJson<Record<string, unknown>>(req);
		} catch {
			return fail(400, "JSON inválido");
		}
		const t = target(d);
		if (typeof t === "string") return fail(400, t);
		let values;
		try {
			values = parseTuningInput(d.values);
		} catch {
			return fail(400, "Algún valor no es válido.");
		}
		if (d.scope === "general") setGeneralTuning(t.provider, values);
		else if (d.scope === "model") setModelTuning(t.provider, t.model, values);
		else return fail(400, "Elige si es para este modelo o para todos.");
		// Al cambiar los generales puede que este modelo ya no se distinga de ellos: se limpia.
		if (d.scope === "general" && getConfig().modelSettings[`${t.provider}|${t.model}`]) {
			setModelTuning(t.provider, t.model, getModelTuning(t.provider, t.model));
		}
		return reply(200, await buildPayload(t.provider, t.model));
	}

	return fail(405, "Método no permitido");
}
