/** Keep ownership alive while a workflow node is awaiting external work. */
export class WorkflowLeaseLostError extends Error {}

export class WorkflowLeaseHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renewal: Promise<void> | null = null;
  private stopped = false;
  private failure: WorkflowLeaseLostError | null = null;

  constructor(
    private readonly renew: () => Promise<boolean>,
    private readonly onLost: (error: WorkflowLeaseLostError) => void,
    private readonly intervalMs = 15_000,
    private readonly timeoutMs = 10_000,
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.assertOwned().then(() => this.start()).catch(() => { /* onLost owns cancellation */ });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async assertOwned(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new WorkflowLeaseLostError('Workflow lease heartbeat has stopped');
    if (this.renewal) return this.renewal;
    this.renewal = this.renewOnce();
    try {
      await this.renewal;
    } finally {
      this.renewal = null;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async renewOnce(): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const owned = await Promise.race([
        this.renew(),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Workflow lease renewal timed out')), this.timeoutMs);
        }),
      ]);
      if (!owned) throw new Error('Workflow execution is terminal or its lease belongs to another worker');
    } catch (error) {
      // A renewal already in flight may finish after normal terminal cleanup.
      if (this.stopped) return;
      this.failure = new WorkflowLeaseLostError(error instanceof Error ? error.message : String(error));
      this.stop();
      this.onLost(this.failure);
      throw this.failure;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
