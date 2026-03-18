const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_MS = 500;

export type RetryPolicy = {
	maxRetries: number;
	baseDelayMs: number;
};

export function createRetryPolicy(opts: { maxRetries?: number; baseDelayMs?: number } = {}): RetryPolicy {
	return {
		maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
		baseDelayMs: opts.baseDelayMs ?? DEFAULT_BASE_MS,
	};
}

export function getBackoffMs(policy: RetryPolicy, attempt: number): number {
	return policy.baseDelayMs * Math.pow(2, attempt);
}

export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
	return attempt < policy.maxRetries;
}

export type RetryableError = {
	retryable: boolean;
	message: string;
};

export function isRetryableError(error: unknown): RetryableError {
	const msg = error instanceof Error ? error.message : String(error);
	const retryablePatterns = [
		"timeout",
		"ETIMEDOUT",
		"ECONNRESET",
		"ECONNREFUSED",
		"EAI_AGAIN",
		"network",
		"fetch failed",
		"rate limit",
		"429",
		"500",
		"502",
		"503",
		"504",
	];
	const retryable = retryablePatterns.some((p) => msg.toLowerCase().includes(p.toLowerCase()));
	return { retryable, message: msg };
}
