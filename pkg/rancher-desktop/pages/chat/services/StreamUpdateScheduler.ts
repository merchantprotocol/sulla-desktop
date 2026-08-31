/**
 * Leading/trailing throttle for renderer stream updates.
 *
 * The leading call is synchronous so publication never depends on the browser
 * reaching an animation frame. A continuous stream is then capped to the
 * configured interval while always retaining one trailing update.
 */
export class StreamUpdateScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;

  constructor(
    private readonly publish: () => void,
    private readonly intervalMs = 32,
  ) {}

  schedule(): void {
    this.pending = true;
    if (this.timer !== null) return;
    this.run();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = false;
    this.publish();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }

  private run(): void {
    this.pending = false;
    this.publish();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) this.run();
    }, this.intervalMs);
  }
}
