// SPDX-License-Identifier: GPL-2.0-or-later
/** Serializes chunk writes and retains a failed chunk so shutdown retries cannot silently skip it. */
export class RecorderChunkQueue {
  private readonly tasks: Array<() => Promise<void>> = [];
  private draining?: Promise<void>;

  enqueue(write: () => Promise<void>): void { this.tasks.push(write); }

  flush(): Promise<void> {
    if (this.draining) return this.draining;
    const operation = this.drain();
    this.draining = operation;
    void operation.finally(() => { if (this.draining === operation) this.draining = undefined; }).catch(() => undefined);
    return operation;
  }

  private async drain(): Promise<void> {
    while (this.tasks.length) {
      await this.tasks[0]();
      this.tasks.shift();
    }
  }
}
