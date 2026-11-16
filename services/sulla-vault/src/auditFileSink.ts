// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * High-volume vault audit (agent credential use, ~4/s) goes to rotating JSONL
 * files instead of Postgres. One event per line. Event objects must never
 * carry secret values; callers pass only identifiers, hostnames and reasons.
 */
export interface AuditFileEvent {
  created_at: string;
  action: string;
  actor_user_id: string | null;
  org_id: string | null;
  collection_id: string | null;
  item_id: string | null;
  pod_id: string | null;
  metadata: Record<string, unknown>;
  blocked: boolean;
  reason: string | null;
}

export interface AuditFileSinkOptions {
  dir: string;
  /** Rotate to a new file once the current one reaches this size. */
  maxFileBytes?: number;
  /** Delete files whose day is older than this many days. */
  retentionDays?: number;
  /** Delete oldest files until all files together fit under this size. */
  maxTotalBytes?: number;
  flushIntervalMs?: number;
  /** Events held in memory between flushes; beyond this, events are dropped and counted. */
  maxBuffered?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

const FILE_PATTERN = /^vault-audit-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;
// Substring match (camelCase and snake_case): any key that could hold a secret is dropped.
const FORBIDDEN_KEY = /value|secret|passw|token|authorization|cookie/i;

const day = (date: Date) => date.toISOString().slice(0, 10);

function stripSecrets(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!FORBIDDEN_KEY.test(key)) out[key] = value;
  }
  return out;
}

export class AuditFileSink {
  private readonly dir: string;
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly maxTotalBytes: number;
  private readonly maxBuffered: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private buffer: string[] = [];
  private droppedSinceReport = 0;
  private droppedTotal = 0;
  private failedTotal = 0;
  private timer?: NodeJS.Timeout;
  private flushing: Promise<void> = Promise.resolve();
  private current?: { name: string; day: string; index: number; bytes: number };
  private dirReady = false;

  constructor(options: AuditFileSinkOptions) {
    this.dir = options.dir;
    this.maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
    this.retentionDays = options.retentionDays ?? 14;
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
    this.maxBuffered = options.maxBuffered ?? 5000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
    const interval = options.flushIntervalMs ?? 1000;
    if (interval > 0) {
      this.timer = setInterval(() => { void this.flush(); }, interval);
      this.timer.unref();
    }
  }

  get dropped(): number { return this.droppedTotal; }
  get failedWrites(): number { return this.failedTotal; }
  get buffered(): number { return this.buffer.length; }

  /** Synchronous and non-throwing: the request path never waits on disk. */
  write(event: Omit<AuditFileEvent, 'created_at'> & { created_at?: string }): void {
    try {
      if (this.buffer.length >= this.maxBuffered) {
        this.droppedTotal++;
        this.droppedSinceReport++;
        return;
      }
      const line = JSON.stringify({
        ...event,
        created_at: event.created_at ?? this.now().toISOString(),
        metadata: stripSecrets(event.metadata ?? {}),
      });
      this.buffer.push(line);
    } catch {
      this.droppedTotal++;
      this.droppedSinceReport++;
    }
  }

  /** Writes buffered events. Safe to call concurrently; calls are serialized. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce()).catch(() => undefined);
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private async flushOnce(): Promise<void> {
    if (this.droppedSinceReport > 0) {
      this.log(`sulla-vault: audit file sink dropped ${ this.droppedSinceReport } event(s) because the write buffer was full (${ this.droppedTotal } total)`);
      this.droppedSinceReport = 0;
    }
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    try {
      if (!this.dirReady) {
        await mkdir(this.dir, { recursive: true });
        this.dirReady = true;
      }
      await this.append(lines);
    } catch (error) {
      this.failedTotal += lines.length;
      this.log(`sulla-vault: audit file sink failed to write ${ lines.length } event(s): ${ (error as Error)?.message ?? 'unknown error' }`);
    }
  }

  private async append(lines: string[]): Promise<void> {
    // Chunk so one flush never makes a file overshoot the size cap by much.
    let batch: string[] = [];
    let batchBytes = 0;
    const commit = async() => {
      if (!batch.length) return;
      const target = await this.targetFile(batchBytes);
      await appendFile(join(this.dir, target.name), batch.join('\n') + '\n', { mode: 0o600 });
      target.bytes += batchBytes;
      batch = [];
      batchBytes = 0;
    };
    for (const line of lines) {
      const size = Buffer.byteLength(line) + 1;
      if (batch.length && batchBytes + size > Math.max(64 * 1024, this.maxFileBytes / 8)) await commit();
      batch.push(line);
      batchBytes += size;
    }
    await commit();
  }

  private async targetFile(incomingBytes: number): Promise<{ name: string; bytes: number }> {
    const today = day(this.now());
    let rotated = false;
    if (!this.current || this.current.day !== today) {
      this.current = await this.openForDay(today);
      rotated = true;
    }
    if (this.current.bytes > 0 && this.current.bytes + incomingBytes > this.maxFileBytes) {
      const index = this.current.index + 1;
      this.current = { name: this.fileName(today, index), day: today, index, bytes: 0 };
      rotated = true;
    }
    if (rotated) await this.prune().catch(() => undefined);
    return this.current;
  }

  private fileName(date: string, index: number): string {
    return index === 0 ? `vault-audit-${ date }.jsonl` : `vault-audit-${ date }.${ index }.jsonl`;
  }

  private async openForDay(date: string): Promise<{ name: string; day: string; index: number; bytes: number }> {
    let index = 0;
    for (const file of await readdir(this.dir)) {
      const match = FILE_PATTERN.exec(file);
      if (match && match[1] === date) index = Math.max(index, Number(match[2] ?? 0));
    }
    const name = this.fileName(date, index);
    const bytes = await stat(join(this.dir, name)).then((s) => s.size, () => 0);
    return { name, day: date, index, bytes };
  }

  /** Lists audit files oldest first. */
  async listFiles(): Promise<Array<{ name: string; day: string; index: number; size: number }>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files = [];
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (!match) continue;
      const size = await stat(join(this.dir, name)).then((s) => s.size, () => -1);
      if (size >= 0) files.push({ name, day: match[1], index: Number(match[2] ?? 0), size });
    }
    return files.sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index);
  }

  /** Enforces the retention window and the total size cap. Never deletes the file being written. */
  async prune(): Promise<number> {
    const files = await this.listFiles();
    const cutoff = day(new Date(this.now().getTime() - this.retentionDays * 86_400_000));
    let total = files.reduce((sum, f) => sum + f.size, 0);
    let removed = 0;
    for (const file of files) {
      if (file.name === this.current?.name) continue;
      if (file.day < cutoff || total > this.maxTotalBytes) {
        await unlink(join(this.dir, file.name)).catch(() => undefined);
        total -= file.size;
        removed++;
      }
    }
    return removed;
  }

  /**
   * Newest-first events that satisfy `accept`, at most `max`. Reads one file at
   * a time; unparseable lines (a torn write) are skipped.
   */
  async readRecent(accept: (event: AuditFileEvent) => boolean, max: number): Promise<AuditFileEvent[]> {
    await this.flush();
    const out: AuditFileEvent[] = [];
    const files = (await this.listFiles()).reverse();
    for (const file of files) {
      if (out.length >= max) break;
      let text: string;
      try {
        text = await readFile(join(this.dir, file.name), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
        if (!lines[i]) continue;
        try {
          const event = JSON.parse(lines[i]) as AuditFileEvent;
          if (accept(event)) out.push(event);
        } catch {
          // skip torn line
        }
      }
    }
    return out;
  }
}
