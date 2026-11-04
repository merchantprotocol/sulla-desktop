// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { Service } from '@sulla/foundation';

export class UsageWriteQueue extends Service {
  private readonly queues = new Map<string, Promise<void>>();
  private accepting = false;
  private disposed = false;
  start(): void {
    if (this.disposed) throw new Error('UsageWriteQueue is disposed');
    this.accepting = true;
  }
  enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    if (!this.accepting || this.disposed) return Promise.reject(new Error('UsageWriteQueue is not running'));
    const queued = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    let tracked: Promise<void>;
    tracked = queued.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    });
    this.queues.set(key, tracked);
    return tracked;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }
  async stop(): Promise<void> {
    this.accepting = false;
    await this.drain();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.stop();
    this.disposed = true;
    this.queues.clear();
  }
  get pending(): number {
    return this.queues.size;
  }
}
