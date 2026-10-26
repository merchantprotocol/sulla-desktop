export const REFRESH_RETRY_DELAY_MS = 60 * 1000;
export const MAX_REFRESH_RETRY_DELAY_MS = 30 * 60 * 1000;

/** Retry delay after `failures` consecutive failures: 60s doubling, capped at 30min. */
export function refreshRetryDelayMs(failures: number): number {
  return Math.min(REFRESH_RETRY_DELAY_MS * 2 ** Math.max(0, failures - 1), MAX_REFRESH_RETRY_DELAY_MS);
}
