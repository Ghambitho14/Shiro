export type ToolExecutor = (args: Record<string, unknown>) => Promise<{ ok: boolean; content: string }>;

const executors: Map<string, ToolExecutor> = new Map();

export function registerToolExecutor(name: string, executor: ToolExecutor): void {
	executors.set(name, executor);
}

export function getToolExecutor(name: string): ToolExecutor | undefined {
	return executors.get(name);
}

export function hasToolExecutor(name: string): boolean {
	return executors.has(name);
}
