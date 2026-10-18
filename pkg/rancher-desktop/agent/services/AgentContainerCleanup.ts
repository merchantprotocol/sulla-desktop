export interface CleanupRetryOptions {
  attempts?:    number;
  baseDelayMs?: number;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Bounded immediate retry used before lifecycle cleanup is allowed to fail. */
export async function retryContainerCleanup(
  action: () => Promise<void>,
  options: CleanupRetryOptions = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 100);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts && baseDelayMs) await wait(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

interface PendingCleanup {
  action:    () => Promise<void>;
  failures:  number;
  lastError: unknown;
}

/**
 * Own unresolved cleanup until it succeeds. The initiating call still rejects,
 * so a job can never report successful cleanup while a container is live.
 */
export class AgentContainerCleanupOwner {
  private readonly pending = new Map<string, PendingCleanup>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private drainPromise: Promise<void> | undefined;

  constructor(
    private readonly report: (message: string) => void,
    private readonly intervalMs = 30_000,
  ) {}

  get pendingCount(): number { return this.pending.size }

  async run(key: string, action: () => Promise<void>): Promise<void> {
    try {
      await retryContainerCleanup(action);
      this.pending.delete(key);
    } catch (error) {
      this.pending.set(key, { action, failures: 1, lastError: error });
      this.ensureTimer();
      this.report(`Cleanup ${ key } remains pending after bounded retry: ${ (error as Error)?.message ?? error }`);
      throw error;
    }
  }

  async retryPendingOnce(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainPending();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = undefined;
    }
  }

  private async drainPending(): Promise<void> {
    for (const [key, pending] of [...this.pending]) {
      try {
        await pending.action();
        this.pending.delete(key);
        this.report(`Cleanup ${ key } recovered after ${ pending.failures } deferred attempt(s)`);
      } catch (error) {
        pending.failures += 1;
        pending.lastError = error;
        this.report(`Cleanup ${ key } still pending after ${ pending.failures } deferred attempt(s): ${ (error as Error)?.message ?? error }`);
      }
    }
    if (this.pending.size === 0) this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.retryPendingOnce().catch(error => this.report(`Cleanup retry owner failed: ${ (error as Error)?.message ?? error }`));
    }, this.intervalMs);
    (this.timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
