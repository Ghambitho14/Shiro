/**
 * Lo que una tool necesita saber de la respuesta en curso (la usa `delegate` para crear
 * ayudantes con el mismo modelo, herramientas, permisos y botón de parar que quien los crea).
 * runAgent lo pone con runWithAgentContext; fuera de una respuesta no hay contexto.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMClient } from "../llm/LLMClient.js";
import type { Approver } from "../tools/approval.js";
import type { UserProfileForAgent } from "./Agent.js";
import type { ThinkingLevel } from "../../config/config.js";
import type { ChatMode, PermissionMode } from "./chatMode.js";

export type AgentRunContext = {
	llm: LLMClient;
	agentName: string;
	/** Los ayudantes heredan el modo, los permisos y el razonamiento; al planear no pueden saltarse el solo lectura. */
	mode: ChatMode;
	permissions: PermissionMode;
	thinking?: ThinkingLevel;
	/** Las herramientas de esta respuesta (undefined = todas). */
	tools: string[] | undefined;
	approver?: Approver;
	signal?: AbortSignal;
	userProfile?: UserProfileForAgent | null;
	workspaceContext?: string;
	sessionId?: string;
	projectId?: string;
	/** Esta respuesta es la de un ayudante: no puede crear otros. */
	subagent: boolean;
	/** Ayudantes creados en esta respuesta (hay un máximo). */
	launched: number;
};

const store = new AsyncLocalStorage<AgentRunContext>();

export function runWithAgentContext<T>(ctx: AgentRunContext, fn: () => Promise<T>): Promise<T> {
	return store.run(ctx, fn);
}

export function currentAgentRun(): AgentRunContext | undefined {
	return store.getStore();
}
