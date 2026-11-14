// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { readFile } from 'node:fs/promises';

export type FilesActivity = { requests: Record<string, number>; indexer: string | null; enrichment: string | null };

/** Emits bounded, greppable process/cgroup memory snapshots for native-memory diagnosis. */
export class MemoryTelemetry {
  private timer?: NodeJS.Timeout;
  private aboveThreshold = false;
  constructor(private readonly activity:() => FilesActivity) {}

  start():void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), 60_000);
    this.timer.unref();
  }
  close():void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  private async sample():Promise<void> {
    const memory = process.memoryUsage();
    let limit:number | null = null;
    try {
      const value = (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim();
      if (value !== 'max') limit = Number(value);
    } catch { /* cgroup v2 may not be mounted in every deployment */ }
    const threshold = limit !== null && Number.isFinite(limit) && memory.rss >= limit * 0.75;
    const crossedThreshold = threshold && !this.aboveThreshold;
    if (!threshold && this.aboveThreshold) this.aboveThreshold = false;
    if (crossedThreshold) this.aboveThreshold = true;
    this.aboveThreshold = threshold;
    const activity = this.activity();
    const mib = (value:number) => Math.round(value / 1024 / 1024);
    console.log(`[SullaFiles] memory rss=${mib(memory.rss)}MiB heapUsed=${mib(memory.heapUsed)}MiB heapTotal=${mib(memory.heapTotal)}MiB external=${mib(memory.external)}MiB arrayBuffers=${mib(memory.arrayBuffers)}MiB limit=${limit === null ? 'unknown' : `${mib(limit)}MiB`} threshold=${crossedThreshold ? 'crossed' : threshold ? 'high' : 'normal'} requests=${JSON.stringify(activity.requests)} indexer=${JSON.stringify(activity.indexer)} enrichment=${JSON.stringify(activity.enrichment)}`);
  }
}
