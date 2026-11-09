// SPDX-License-Identifier: GPL-2.0-or-later
/** Serializes recording transitions and invalidates asynchronous startup before teardown. */
export class CaptureSessionLifecycle {
  private active?: Promise<void>;
  private readonly startups = new Set<Promise<void>>();
  private shutdown?: Promise<void>;
  private closing = false;

  get isClosing(): boolean { return this.closing; }

  run(transition: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.active) return this.active;
    const active = Promise.resolve().then(transition);
    this.active = active;
    void active.finally(() => { if (this.active === active) this.active = undefined; }).catch(() => undefined);
    return active;
  }

  /** Independent source enables must all drain; recording transitions still join run(). */
  track(startup: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve();
    const pending = Promise.resolve().then(() => this.closing ? undefined : startup());
    this.startups.add(pending);
    void pending.finally(() => this.startups.delete(pending)).catch(() => undefined);
    return pending;
  }

  /** Guard every acquisition entry point, including RPC, setup and device menus. */
  protect<Args extends unknown[], Result>(acquire: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return async(...args) => {
      if (this.closing) throw new Error('Capture Studio is closing');
      const acquisition = acquire(...args);
      const drained = acquisition.then(() => undefined, () => undefined);
      this.startups.add(drained);
      try {
        const result = await acquisition;
        if (this.closing) throw new Error('Capture Studio is closing');
        return result;
      } finally { this.startups.delete(drained); }
    };
  }

  close(flushAndRelease: () => Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = this.finish(flushAndRelease);
    return this.shutdown;
  }

  private async finish(flushAndRelease: () => Promise<void>): Promise<void> {
    // Any deferred audio startup must settle before its matching stop/release.
    try { await this.active; } catch { /* Cleanup still owns every acquired resource. */ }
    await Promise.allSettled([...this.startups]);
    await flushAndRelease();
  }
}
