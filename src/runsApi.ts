/**
 * Ajustes → Registro (`/api/runs`): las últimas respuestas de Aku con sus herramientas, tiempos, tokens y
 * errores (`core/agent/runLog.ts`), y el examen del agente (`/api/agent-exam`, `core/agent/agentExam.ts`).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "./http.js";
import { clearRunLog, readRunLog, summarizeRuns } from "./core/agent/runLog.js";
import { examStatus, listExamTasks, startExam } from "./core/agent/agentExam.js";

export async function handleRunsApi(req: IncomingMessage, res: ServerResponse, method: string, pathname: string, url: URL): Promise<boolean> {
	if (pathname === "/api/runs") {
		if (method === "GET") {
			const limit = Number(url.searchParams.get("limit")) || 100;
			const sessionId = url.searchParams.get("session") || undefined;
			const entries = readRunLog({ limit, sessionId });
			sendJson(res, 200, { entries, summary: summarizeRuns(entries) });
			return true;
		}
		if (method === "DELETE") {
			clearRunLog();
			sendJson(res, 200, { ok: true });
			return true;
		}
	}

	if (pathname === "/api/agent-exam") {
		if (method === "GET") {
			sendJson(res, 200, { tasks: listExamTasks(), status: examStatus() });
			return true;
		}
		if (method === "POST") {
			const body = await readJson<{ only?: string[] }>(req).catch(() => ({}) as { only?: string[] });
			try {
				startExam(Array.isArray(body.only) ? body.only.map(String) : undefined);
				sendJson(res, 200, { status: examStatus() });
			} catch (err) {
				sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
			}
			return true;
		}
	}
	return false;
}
