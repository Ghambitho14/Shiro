/**
 * Shiro TUI - Interfaz estilo OpenCode
 * Layout: Panel lateral (chat) + Área principal (terminal/editor)
 */

import { input } from "@inquirer/prompts";
import { getState } from "./store.js";
import { getUserProfile } from "./user-profile.js";
import { getConfig } from "./config/config.js";
import { buildWorkspaceContext } from "./workspace.js";
import { getLLM } from "./core/llm/getLLM.js";
import { MemoryManager } from "./core/memory/MemoryManager.js";
import { runAgent } from "./core/agent/Agent.js";
import { readdirSync } from "node:fs";

const COLORS = {
	W: "\x1b[0m",
	K: "\x1b[38;5;15m",
	B: "\x1b[38;5;31m",
	G: "\x1b[38;5;76m",
	Y: "\x1b[38;5;226m",
	C: "\x1b[38;5;45m",
	P: "\x1b[38;5;163m",
	Gr: "\x1b[38;5;242m",
	D: "\x1b[38;5;246m",
	bgD: "\x1b[48;5;234m",
	bgL: "\x1b[48;5;238m",
};

function safeRepeat(count: number): string {
	return " ".repeat(Math.max(0, count));
}

function clearScreen() {
	process.stdout.write("\x1b[2J\x1b[3J");
}

function hideCursor() { process.stdout.write("\x1b[?25l"); }
function showCursor() { process.stdout.write("\x1b[?25h"); }

function getTerminalSize(): { width: number; height: number } {
	const size = process.stdout.getWindowSize();
	return { width: size[0] || 80, height: size[1] || 24 };
}

interface ChatMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
}

class ShiroTUI {
	private state = getState();
	private config = getConfig();
	private memory = new MemoryManager({ shortWindow: 50, summarizeEvery: 20 });
	private workspaceContext = "";
	private history: ChatMessage[] = [];
	private termWidth = 80;
	private termHeight = 24;
	private running = true;
	private files: string[] = [];
	private cwd = "";
	
	constructor() {
		this.workspaceContext = buildWorkspaceContext({ includeLongTermMemory: true }) || "";
		this.cwd = process.cwd();
		this.loadFiles();
	}
	
	private loadFiles() {
		try {
			const entries = readdirSync(this.cwd).filter(f => !f.startsWith("."));
			this.files = entries.slice(0, 50);
		} catch {
			this.files = [];
		}
	}
	
	private async checkLlmConnection(): Promise<boolean> {
		try {
			const llm = getLLM();
			const cfg = llm.getConfig();
			const res = await fetch(cfg.baseUrl + "/models", {
				method: "GET",
				headers: cfg.model ? { "Authorization": `Bearer ${cfg.model}` } : {}
			});
			return res.ok;
		} catch {
			return false;
		}
	}
	
	private drawLayout() {
		clearScreen();
		hideCursor();
		
		const W = this.termWidth;
		const H = this.termHeight;
		const sidebarW = Math.min(35, Math.floor(W * 0.35));
		const mainW = W - sidebarW - 1;
		
		process.stdout.write(`\x1b[1;1H`);
		process.stdout.write(`${COLORS.bgL}${COLORS.C} Shiro ${COLORS.W} ${COLORS.bgD}${COLORS.Gr}│${COLORS.W} ${COLORS.Gr}Terminal${COLORS.W}    ${COLORS.Gr}│${COLORS.W} ${COLORS.Gr}Editor${COLORS.W}     ${COLORS.Gr}│${COLORS.W} ${COLORS.Gr}Status${COLORS.W}`);
		
		process.stdout.write(`\x1b[2;1H`);
		process.stdout.write(COLORS.Gr + "─".repeat(Math.max(0, sidebarW)) + "┼" + "─".repeat(Math.max(0, mainW)) + "┤" + COLORS.W);
		
		for (let y = 3; y < H - 8; y++) {
			process.stdout.write(`\x1b[${y};1H`);
			process.stdout.write(COLORS.Gr + "│" + COLORS.W + safeRepeat(sidebarW - 2));
			process.stdout.write(`\x1b[${y};${sidebarW + 1}H`);
			process.stdout.write(COLORS.Gr + "│" + COLORS.W);
		}
		
		process.stdout.write(`\x1b[3;${sidebarW + 1}H`);
		process.stdout.write(COLORS.Gr + "│" + COLORS.W);
		
		for (let y = 3; y < H - 8; y++) {
			process.stdout.write(`\x1b[${y};${sidebarW + 2}H`);
			process.stdout.write(safeRepeat(mainW - 1));
		}
		
		const statusY = H - 7;
		process.stdout.write(`\x1b[${statusY};1H`);
		process.stdout.write(COLORS.Gr + "├" + "─".repeat(Math.max(0, sidebarW)) + "┼" + "─".repeat(Math.max(0, mainW)) + "┤" + COLORS.W);
		
		const inputY = H - 5;
		process.stdout.write(`\x1b[${inputY};1H`);
		process.stdout.write(`${COLORS.Gr}│${COLORS.K}➤ ${COLORS.W}${safeRepeat(sidebarW - 3)}`);
		process.stdout.write(`\x1b[${inputY};${sidebarW + 1}H`);
		process.stdout.write(`${COLORS.Gr}│${COLORS.W}`);
		
		process.stdout.write(`\x1b[${H - 1};1H`);
		process.stdout.write(COLORS.bgD + COLORS.Gr + " /ayuda /salir /status /files " + safeRepeat(W - 50) + COLORS.W);
	}
	
	private drawChat() {
		const sidebarW = Math.min(35, Math.floor(this.termWidth * 0.35));
		let y = 3;
		
		process.stdout.write(`\x1b[${y};2H`);
		process.stdout.write(`${COLORS.C}Conversación${COLORS.W}`);
		y += 2;
		
		const recent = this.history.slice(-8);
		for (const msg of recent) {
			if (y > this.termHeight - 10) break;
			
			const prefix = msg.role === "user" ? `${COLORS.K}➤${COLORS.W}` : `${COLORS.C}★${COLORS.W}`;
			const lines = this.wrapText(msg.content, sidebarW - 4);
			
			for (const line of lines.slice(0, 3)) {
				process.stdout.write(`\x1b[${y};2H`);
				process.stdout.write(`${prefix} ${line}`);
				y++;
			}
			y++;
		}
	}
	
	private wrapText(text: string, maxW: number): string[] {
		if (maxW <= 1) return [text.slice(0, 1)];
		const words = text.split(" ");
		const lines: string[] = [];
		let line = "";
		
		for (const w of words) {
			if ((line + " " + w).length > maxW) {
				if (line) lines.push(line);
				line = w;
			} else {
				line = line ? line + " " + w : w;
			}
		}
		if (line) lines.push(line);
		return lines;
	}
	
	private async run() {
		const { width, height } = getTerminalSize();
		this.termWidth = width;
		this.termHeight = height;
		
		this.drawLayout();
		this.drawChat();
		
		const connected = await this.checkLlmConnection();
		
		process.stdout.write(`\x1b[${this.termHeight - 6};2H`);
		if (connected) {
			process.stdout.write(`${COLORS.G}●${COLORS.W} Conectado`);
		} else {
			process.stdout.write(`${COLORS.Y}●${COLORS.W} Sin conexión LLM`);
		}
		
		while (this.running) {
			const inputY = this.termHeight - 5;
			process.stdout.write(`\x1b[${inputY};4}H`);
			process.stdout.write(COLORS.bgL + " ".repeat(28) + COLORS.W);
			process.stdout.write(`\x1b[${inputY};4}H`);
			
			try {
				const msg = await input({ message: "" });
				await this.handleInput(msg);
			} catch (e) {
				if ((e as Error)?.name === "ExitPromptError") {
					this.running = false;
				}
			}
		}
		
		showCursor();
		process.stdout.write("\n");
	}
	
	private async handleInput(msg: string) {
		const cmd = msg.trim().toLowerCase();
		
		if (!cmd) return;
		
		this.history.push({
			role: "user",
			content: msg,
			timestamp: Date.now(),
		});
		
		if (cmd === "/salir" || cmd === "/exit") {
			this.running = false;
			return;
		}
		
		if (cmd === "/clear") {
			this.history = [];
			this.drawLayout();
			return;
		}
		
		if (cmd === "/ayuda" || cmd === "/help") {
			this.showHelp();
			return;
		}
		
		if (cmd === "/status") {
			this.showStatus();
			return;
		}

		if (cmd.startsWith("/explain") || cmd.startsWith("/explica")) {
			const parts = msg.trim().split(/\s+/);
			const mode = (parts[1] ?? "").toLowerCase();
			if (mode === "off" || mode === "brief" || mode === "on") {
				const { setConfig, getConfig } = await import("./config/config.js");
				setConfig({ explainMode: mode });
				this.config = getConfig();
				this.history.push({ role: "system", content: `explainMode = ${mode}`, timestamp: Date.now() });
			} else {
				this.history.push({ role: "system", content: "Uso: /explain off|brief|on", timestamp: Date.now() });
			}
			this.drawLayout();
			this.drawChat();
			return;
		}
		
		if (cmd === "/files") {
			this.showFiles();
			return;
		}
		
		this.drawLayout();
		this.drawChat();
		
		const inputY = this.termHeight - 5;
		process.stdout.write(`\x1b[${inputY};4}H`);
		process.stdout.write(`${COLORS.Gr}🤔 Pensando...${COLORS.W}`);
		
		try {
			// Para que el comportamiento sea consistente con `server.ts` y `whatsapp.ts`,
			// pasamos el historial (solo user/assistant) como contexto conversacional.
			const conversation = this.history
				.filter((m) => m.role === "user" || m.role === "assistant")
				.slice(-20)
				.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

			const response = await runAgent(msg, {
				llm: getLLM(),
				memory: this.memory,
				agentName: this.state.name,
				tokenBudget: 8000,
				textOnly: this.config.autonomousMode === false,
				explainMode: this.config.explainMode,
				userProfile: getUserProfile(),
				conversation,
			}, this.workspaceContext || undefined);
			
			this.history.push({
				role: "assistant",
				content: response,
				timestamp: Date.now(),
			});
		} catch (e) {
			this.history.push({
				role: "system",
				content: "Error: " + (e instanceof Error ? e.message : String(e)),
				timestamp: Date.now(),
			});
		}
		
		this.drawLayout();
		this.drawChat();
	}
	
	private showHelp() {
		this.drawLayout();
		
		const sidebarW = Math.min(35, Math.floor(this.termWidth * 0.35));
		let y = 3;
		
		process.stdout.write(`\x1b[${y};2H${COLORS.C}Comandos:${COLORS.W}`);
		y++;
		
		const commands = [
			["/ayuda", "Mostrar ayuda"],
			["/status", "Estado del sistema"],
			["/files", "Archivos del proyecto"],
			["/clear", "Limpiar chat"],
			["/salir", "Salir"],
		];
		
		for (const [c, desc] of commands) {
			process.stdout.write(`\x1b[${y};2H${COLORS.G}${c}${COLORS.W} - ${desc}`);
			y++;
		}
	}
	
	private showStatus() {
		const llm = getLLM();
		const cfg = llm.getConfig();
		
		this.drawLayout();
		
		let y = 3;
		process.stdout.write(`\x1b[${y};2H${COLORS.C}Estado:${COLORS.W}`);
		y++;
		process.stdout.write(`\x1b[${y};2H${COLORS.Gr}Proveedor:${COLORS.W} ${this.config.llmProvider}`);
		y++;
		process.stdout.write(`\x1b[${y};2H${COLORS.Gr}Modelo:${COLORS.W} ${cfg.model}`);
		y++;
		process.stdout.write(`\x1b[${y};2H${COLORS.Gr}URL:${COLORS.W} ${cfg.baseUrl}`);
		y++;
		process.stdout.write(`\x1b[${y};2H${COLORS.Gr}Modo:${COLORS.W} ${this.config.autonomousMode ? "Autónomo" : "Texto"}`);
	}
	
	private showFiles() {
		this.drawLayout();
		
		let y = 3;
		process.stdout.write(`\x1b[${y};2H${COLORS.C}Archivos (${this.cwd}):${COLORS.W}`);
		y++;
		
		for (const f of this.files.slice(0, 15)) {
			if (y > this.termHeight - 10) break;
			process.stdout.write(`\x1b[${y};2H${COLORS.Gr}📄 ${COLORS.W}${f}`);
			y++;
		}
	}
	
	public start() {
		this.run().catch(console.error);
	}
}

export function runShiroTUI(): void {
	const tui = new ShiroTUI();
	tui.start();
}
