import type { MemoryStore } from "./MemoryStore.js";
import { MemoryManager } from "./MemoryManager.js";

const DEFAULT_SHORT_WINDOW = 50;
const SUMMARIZE_EVERY_N = 20;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour inactivity
const DEFAULT_MAX_ENTRIES = 500;

type Entry = { manager: MemoryManager; lastUsed: number };

export type SessionMemoryStoreOptions = {
	ttlMs?: number;
	maxEntries?: number;
};

export type SessionMemoryStoreHandle = {
	getMemory(sessionId: string): MemoryStore;
	delete(sessionId: string): void;
};

/**
 * Creates a per-session/per-channel memory store with get-or-create and lifecycle cleanup.
 * Each transport (HTTP, WhatsApp) should create its own instance so session IDs stay isolated.
 * Cleanup runs lazily on getMemory: evict by TTL (inactivity), then by LRU if over maxEntries.
 */
export function createSessionMemoryStore(opts?: SessionMemoryStoreOptions): SessionMemoryStoreHandle {
	const map = new Map<string, Entry>();
	const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = Math.max(1, opts?.maxEntries ?? DEFAULT_MAX_ENTRIES);

	function evictExpired(): void {
		const now = Date.now();
		for (const [id, entry] of map.entries()) {
			if (now - entry.lastUsed > ttlMs) map.delete(id);
		}
	}

	function evictIfOverCapacity(): void {
		if (map.size <= maxEntries) return;
		const byAge = [...map.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		const toRemove = byAge.slice(0, map.size - maxEntries);
		for (const [id] of toRemove) map.delete(id);
	}

	function cleanup(): void {
		evictExpired();
		evictIfOverCapacity();
	}

	return {
		getMemory(sessionId: string): MemoryStore {
			cleanup();
			let entry = map.get(sessionId);
			if (!entry) {
				entry = {
					manager: new MemoryManager({
						shortWindow: DEFAULT_SHORT_WINDOW,
						summarizeEvery: SUMMARIZE_EVERY_N,
					}),
					lastUsed: Date.now(),
				};
				map.set(sessionId, entry);
			} else {
				entry.lastUsed = Date.now();
			}
			return entry.manager;
		},
		delete(sessionId: string): void {
			map.delete(sessionId);
		},
	};
}
