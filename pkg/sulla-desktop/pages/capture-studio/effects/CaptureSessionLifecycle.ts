// SPDX-License-Identifier: GPL-2.0-or-later
/** Serializes recording transitions and invalidates asynchronous startup before teardown. */
export class CaptureSessionLifecycle {
  private active?: Promise<void>;
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

  close(flushAndRelease: () => Promise<void>): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.shutdown = this.finish(flushAndRelease);
    return this.shutdown;
  }

  private async finish(flushAndRelease: () => Promise<void>): Promise<void> {
    // Any deferred audio startup must settle before its matching stop/release.
    try { await this.active; } catch { /* Cleanup still owns every acquired resource. */ }
    await flushAndRelease();
  }
}
