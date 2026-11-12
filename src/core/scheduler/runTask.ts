/**
 * Hace una tarea programada y entrega el resultado (la web, Telegram o ambos).
 *
 * - `agent`: Aku hace lo pedido sin approver (como en Telegram): sin control del PC ni nada que pida
 *   permiso, solo con `SCHEDULED_TOOLS` (leer la web, su memoria, sus chats y el proyecto de la tarea).
 *   Cada ejecución empieza de cero y queda guardada en el chat «Tareas programadas».
 * - `notify`/`reminder`: manda el mensaje tal cual.
 * - `exec`: el comando que el usuario aprobó al crear la tarea; manda cómo terminó y el final de la salida.
 */
import { exec } from "node:child_process";
import { getState } from "../../store.js";
import { getUserProfile } from "../../user-profile.js";
import { buildWorkspaceContext } from "../../workspace.js";
import { runAgent } from "../agent/Agent.js";
import { getLLM } from "../llm/getLLM.js";
import { getChatSession, getOrCreateLinkedChatSession, renameChatSession, saveChatSession } from "../../chat/ChatStore.js";
import { pushWebNotice } from "../reminders/notifications.js";
import { getProject } from "../projects/projects.js";
import type { CronTask } from "./CronService.js";

/** Herramientas de una tarea `agent`: nada con efectos fuera de leer. */
export const SCHEDULED_TOOLS = [
	"search_web",
	"fetch_url",
	"get_weather",
	"get_time",
	"calculator",
	"cve_search",
	"memory_search",
	"list_reminders",
	"sessions_list",
	"sessions_history",
	"cron_list",
	"read_file",
	"list_dir",
	"project",
	// Leer correo y agenda («resúmeme mis correos cada mañana»). Enviar o crear eventos necesita permiso,
	// y una tarea no puede pedirlo: queda bloqueado.
	"email",
	"calendar",
];

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;
const CHAT_CHANNEL = "cron";
const CHAT_ID = "tareas";
const CHAT_TITLE = "Tareas programadas";

async function runAgentTask(task: CronTask): Promise<string> {
	const prompt = String(task.payload.prompt ?? "").trim();
	const project = task.projectId ? getProject(task.projectId) : null;
	if (task.projectId && !project) throw new Error("El proyecto de esta tarea ya no existe.");
	const goal =
		`Tarea programada «${task.name}» (la pidió el usuario antes; ahora no está mirando el chat). ` +
		`Hazla y responde con el resultado listo para leer en el móvil: claro y breve, sin preguntas de vuelta.\n\n${prompt}`;
	const reply = await runAgent(
		goal,
		{
			llm: getLLM(),
			agentName: getState().name,
			allowedTools: SCHEDULED_TOOLS,
			explainMode: "off",
			userProfile: getUserProfile(),
			signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
			...(project ? { projectId: project.id } : {}),
			mode: "chat",
		},
		buildWorkspaceContext({ includeLongTermMemory: true }) || undefined,
	);
	const text = reply.trim();
	if (!text) throw new Error("El modelo no devolvió nada.");
	await saveToChat(task, prompt, text);
	return text;
}

/** Deja la ejecución en el chat «Tareas programadas» para revisarla después. */
async function saveToChat(task: CronTask, prompt: string, reply: string): Promise<void> {
	try {
		const chat = await getOrCreateLinkedChatSession(CHAT_CHANNEL, CHAT_ID, CHAT_TITLE);
		const latest = (await getChatSession(chat.id))?.messages ?? chat.messages;
		await saveChatSession(chat.id, [
			...latest,
			{ role: "user", content: `⏰ ${task.name}: ${prompt}` },
			{ role: "assistant", content: reply },
		]);
		// Guardar pone de título el primer mensaje: este chat conserva su nombre.
		await renameChatSession(chat.id, CHAT_TITLE);
	} catch (err) {
		console.error("[Tareas] No pude guardar el resultado en el chat:", err instanceof Error ? err.message : err);
	}
}

function runCommand(command: string): Promise<string> {
	return new Promise((resolve) => {
		exec(command, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
			const output = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
			const tail = output.length > 1500 ? `…${output.slice(-1500)}` : output;
			const status = error ? (error.killed ? "se cortó por tardar más de 5 minutos" : `terminó con error (código ${error.code ?? "?"})`) : "terminó bien";
			resolve(`El comando «${command}» ${status}.${tail ? `\n\n${tail}` : ""}`);
		});
	});
}

/** Hace la tarea y la entrega. Lo que falle al entregar va en `error`, pero el resultado se conserva. */
export async function runScheduledTask(task: CronTask): Promise<{ result?: string; error?: string }> {
	let body: string;
	switch (task.action) {
		case "agent":
			body = await runAgentTask(task);
			break;
		case "exec":
			body = await runCommand(String(task.payload.command ?? ""));
			break;
		default:
			body = String(task.payload.message ?? task.name);
	}
	const title = `⏰ ${task.name}`;
	const deliver = task.deliver ?? "both";
	const errors: string[] = [];

	if (deliver === "telegram" || deliver === "both") {
		try {
			const { sendTelegramNotice } = await import("../../telegram.js");
			await sendTelegramNotice(`${title}\n\n${body}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Con «ambos», si Telegram no está conectado basta con la web: no es un error.
			if (deliver === "telegram") errors.push(message);
		}
	}
	// Solo Telegram y falló: el aviso llega a la web igual, para que no se pierda.
	if (deliver === "web" || deliver === "both" || errors.length) {
		const now = new Date().toISOString();
		pushWebNotice({ id: `${task.id}_${Date.now()}`, title: task.name, description: body, datetime: now, createdAt: now, kind: "task" });
	}
	return { result: body, ...(errors.length ? { error: errors.join(" ") } : {}) };
}
