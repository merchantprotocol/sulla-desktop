// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Swappable timer so the backoff can be driven by a fake clock in tests. */
export interface CompletionRetryTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export class SystemCompletionRetryTimer implements CompletionRetryTimer {
  set(callback: () => void, delayMs: number): unknown {
    const handle = setTimeout(callback, delayMs);
    (handle as any)?.unref?.();
    return handle;
  }

  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/**
 * Exponential, capped delay for completions handed back after a failed
 * delivery. Without it a persistent failure (database down, model erroring)
 * requeued and re-fired the idle dispatcher immediately: a hot retry loop.
 */
export class CompletionRequeueBackoff {
  static readonly BASE_DELAY_MS = 1_000;
  static readonly MAX_DELAY_MS = 180_000;
  private static readonly ATTEMPT_KEY_LIMIT = 2048;
  private readonly attempts = new Map<string, number>();
  private readonly waiting = new Map<string, unknown>();

  constructor(
    private readonly timer: CompletionRetryTimer = new SystemCompletionRetryTimer(),
    private readonly baseDelayMs = CompletionRequeueBackoff.BASE_DELAY_MS,
    private readonly maxDelayMs = CompletionRequeueBackoff.MAX_DELAY_MS,
  ) {}

  isWaiting(key: string): boolean {
    return this.waiting.has(key);
  }

  /** Runs `retry` after the next delay for this key; returns that delay, or -1 when a retry is already pending. */
  schedule(key: string, retry: () => void): number {
    if (this.waiting.has(key)) return -1;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.delete(key);
    this.attempts.set(key, attempt);
    while (this.attempts.size > CompletionRequeueBackoff.ATTEMPT_KEY_LIMIT) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.attempts.delete(oldest);
    }
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(attempt - 1, 30));
    this.waiting.set(key, this.timer.set(() => {
      this.waiting.delete(key);
      retry();
    }, delay));
    return delay;
  }

  clear(): void {
    for (const handle of this.waiting.values()) this.timer.clear(handle);
    this.waiting.clear();
    this.attempts.clear();
  }
}
