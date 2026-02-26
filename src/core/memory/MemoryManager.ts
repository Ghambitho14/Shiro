import type { AgentEvent, LongTermSummary } from "../agent/Types.js";
import type { MemoryStore } from "./MemoryStore.js";
import { summarize } from "./Summarizer.js";

const DEFAULT_SHORT_WINDOW = 50;
const SUMMARIZE_EVERY_N = 20;

export class MemoryManager implements MemoryStore {
	private short: AgentEvent[] = [];
	private longTerm: LongTermSummary | null = null;
	private readonly shortWindow: number;
	private readonly summarizeEvery: number;
	private counter = 0;

	constructor(opts: { shortWindow?: number; summarizeEvery?: number } = {}) {
		this.shortWindow = opts.shortWindow ?? DEFAULT_SHORT_WINDOW;
		this.summarizeEvery = opts.summarizeEvery ?? SUMMARIZE_EVERY_N;
	}

	push(event: AgentEvent): void {
		this.short.push(event);
		if (this.short.length > this.shortWindow) {
			this.short = this.short.slice(-this.shortWindow);
		}
		this.counter++;
		if (this.counter >= this.summarizeEvery) {
			this.longTerm = summarize(this.short);
			this.counter = 0;
		}
	}

	getRecent(n: number): AgentEvent[] {
		return this.short.slice(-n);
	}

	getLongTerm(): LongTermSummary | null {
		return this.longTerm;
	}

	setLongTerm(summary: LongTermSummary): void {
		this.longTerm = summary;
	}

	clearShort(): void {
		this.short = [];
		this.counter = 0;
	}

	/** Fuerza resumen ahora con los eventos actuales. */
	forceSummarize(): void {
		if (this.short.length > 0) {
			this.longTerm = summarize(this.short);
		}
		this.counter = 0;
	}
}
