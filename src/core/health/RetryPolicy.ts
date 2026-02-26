const DEFAULT_MAX_RETRIES = 2;
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
