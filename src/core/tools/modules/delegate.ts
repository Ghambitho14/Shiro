import { loadAgents, agentNames, type AgentProfile } from "../../agents/registry.js";
import { normalizeName } from "../../agents/text.js";
import { currentAgentRun } from "../../agent/runContext.js";
import { getLLMFor } from "../../llm/getLLM.js";
import { office } from "../../office/office.js";
import { getAllToolNames } from "../ToolRegistry.js";
import type { Approver } from "../approval.js";

/** Ayudantes por llamada y por respuesta: más se vuelve lento y caro, y el jefe se pierde. */
export const MAX_TASKS_PER_CALL = 4;
export const MAX_SUBAGENTS_PER_RESPONSE = 8;
const DEFAULT_MINUTES = 5;
const MAX_MINUTES = 20;
/** Lo que vuelve al jefe entre todos los resultados (los modelos locales tienen poco contexto). */
const RESULTS_BUDGET_CHARS = 10_000;
/** Colores de los ayudantes temporales (los agentes de Ajustes usan el suyo). */
const COLORS = ["#7c6cf2", "#e0864a", "#3fa37a", "#d65c8a", "#4a90d9", "#b8a03a"];

type TaskInput = { task: string; agent?: string; name?: string };

/** Un agente de Ajustes → Agentes por su nombre o alias. */
export function findAgentByName(agents: AgentProfile[], name: string): AgentProfile | undefined {
	const n = normalizeName(name);
	return n ? agents.find((a) => agentNames(a).includes(n)) : undefined;
}

/** Las herramientas del ayudante: las de su jefe (sin `delegate`), recortadas a las del agente si tiene lista propia. */
export function subagentTools(bossTools: string[] | undefined, profile?: AgentProfile): string[] {
	const base = (bossTools ?? getAllToolNames()).filter((t) => t !== "delegate");
	if (!profile || profile.tools === "inherit") return base;
	if (profile.tools === "none") return [];
	return base.filter((t) => (profile.tools as string[]).includes(t));
}

function clip(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…(recortado)" : text;
}

/**
 * delegate: Shiro reparte tareas a ayudantes que trabajan a la vez (con modelos de la nube; los locales,
 * por turnos: `modelGate`) y le devuelven su resultado. Cada uno sale en el panel "Oficina".
 */
export async function executeDelegate(args: Record<string, unknown>): Promise<{ ok: boolean; content: string }> {
	const ctx = currentAgentRun();
	if (!ctx) return { ok: false, content: "delegate solo funciona dentro de una respuesta de Aku." };
	if (ctx.subagent) return { ok: false, content: "Eres un ayudante: no puedes crear otros. Haz la tarea tú." };

	const tasks = (Array.isArray(args.tasks) ? args.tasks : []) as TaskInput[];
	if (!tasks.length) return { ok: false, content: "Indica al menos una tarea en tasks." };
	if (tasks.length > MAX_TASKS_PER_CALL) return { ok: false, content: `Como mucho ${MAX_TASKS_PER_CALL} tareas a la vez. Junta las parecidas.` };
	const left = MAX_SUBAGENTS_PER_RESPONSE - ctx.launched;
	if (tasks.length > left) {
		return { ok: false, content: `Ya creaste ${ctx.launched} ayudantes en esta respuesta (máximo ${MAX_SUBAGENTS_PER_RESPONSE}). Termina con lo que tienes.` };
	}
	ctx.launched += tasks.length;
	const minutes = Math.min(MAX_MINUTES, Math.max(1, Number(args.timeout_minutes) || DEFAULT_MINUTES));

	// Import diferido: Agent.ts importa las tools (y estas, a Agent.ts).
	const { runAgent } = await import("../../agent/Agent.js");
	const agents = loadAgents().agents;
	const usedNames = new Set<string>();

	const runs = tasks.map(async (t, i) => {
		const profile = t.agent ? findAgentByName(agents, t.agent) : undefined;
		let name = profile?.name ?? ((t.name || t.agent || "").trim().slice(0, 30) || `Ayudante ${i + 1}`);
		while (usedNames.has(name)) name += "'";
		usedNames.add(name);

		const stop = new AbortController();
		const timeout = AbortSignal.timeout(minutes * 60_000);
		const signal = AbortSignal.any([stop.signal, timeout, ...(ctx.signal ? [ctx.signal] : [])]);
		const desk = office.open({ name, color: profile?.color ?? COLORS[i % COLORS.length], boss: ctx.agentName, task: t.task }, () => stop.abort());
		// Los permisos que pida el ayudante llevan su nombre.
		const approver: Approver | undefined = ctx.approver
			? (req) => ctx.approver!({ ...req, summary: `${name} (ayudante de ${ctx.agentName}): ${req.summary}` })
			: undefined;

		let text = "";
		try {
			text = await runAgent(t.task, {
				llm: profile ? getLLMFor(profile) : ctx.llm,
				agentName: name,
				mode: ctx.mode,
				permissions: ctx.permissions,
				thinking: ctx.thinking,
				allowedTools: subagentTools(ctx.tools, profile),
				// Las tools MCP ya van en la lista del jefe si las tenía.
				mcp: false,
				explainMode: "off",
				persona: profile?.persona.trim() ? { prompt: profile.persona, replace: profile.personaMode === "replace" } : undefined,
				subagent: { boss: ctx.agentName },
				userProfile: ctx.userProfile,
				approver,
				signal,
				sessionId: ctx.sessionId,
				projectId: ctx.projectId,
				onToolEvent: (e) => e.phase === "start" && office.step(desk.id, e.label),
			}, ctx.workspaceContext);
		} catch (err) {
			text = `⚠️ ${err instanceof Error ? err.message : String(err)}`;
		}

		let status: "done" | "error" | "stopped" = "done";
		if (signal.aborted) {
			status = "stopped";
			const why = ctx.signal?.aborted ? "Se detuvo la respuesta." : timeout.aborted ? `Se acabó su tiempo (${minutes} min).` : "El usuario lo detuvo.";
			text = text.trim() ? `${text.trim()}\n\n(${why})` : why;
		} else if (text.startsWith("⚠️")) {
			status = "error";
		}
		office.finish(desk.id, status, text);
		return { name, task: t.task, status, text };
	});

	const results = await Promise.all(runs);
	const each = Math.floor(RESULTS_BUDGET_CHARS / results.length);
	const label = { done: "terminó", error: "falló", stopped: "se detuvo" } as const;
	const body = results
		.map((r) => `### ${r.name} (${label[r.status]})\nTarea: ${clip(r.task, 300)}\n\n${clip(r.text.trim() || "(sin respuesta)", each)}`)
		.join("\n\n");
	const ok = results.some((r) => r.status === "done");
	return { ok: true, content: `Resultados de tus ayudantes${ok ? "" : " (ninguno terminó bien)"}:\n\n${body}` };
}
