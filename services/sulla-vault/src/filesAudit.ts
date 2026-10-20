import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { VaultConfig } from './config.js';

const AUDIT_SPOOL = 'vault-audit-spool.jsonl';
const MAX_SPOOL_EVENTS = 10_000;

export interface VaultAuditEvent {
  subjectKind: 'vault-secret'; subjectId: string; action: string; actor: string; result: string;
  requestId?: string; path?: string; meta?: Record<string, string>;
}

const FORBIDDEN_META = /(?:^|_|-)(?:value|secret|password|token)(?:$|_|-)/i;

function safeMeta(meta: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!meta) return undefined;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!FORBIDDEN_META.test(key) && typeof value === 'string' && value.length <= 512) output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

export class FilesAuditEmitter {
  private tail: Promise<void> = Promise.resolve();
  private readonly endpoint?: string;
  private readonly spoolPath: string;
  private readonly fetcher: typeof fetch;
  private readonly ready: Promise<void>;
  private pending: VaultAuditEvent[] = [];
  private droppedCount = 0;

  constructor(private readonly config: VaultConfig, fetcher: typeof fetch = fetch) {
    this.endpoint = config.filesApiUrl ? `${ config.filesApiUrl.replace(/\/+$/, '') }/v1/system/audit-events` : undefined;
    this.spoolPath = join(config.auditSpoolDir ?? '/var/lib/sulla-vault', AUDIT_SPOOL);
    this.fetcher = fetcher;
    this.ready = this.endpoint && config.filesServiceToken ? this.loadSpool() : Promise.resolve();
  }

  emit(event: VaultAuditEvent): void {
    if (!this.endpoint || !this.config.filesServiceToken) return;
    const safe: VaultAuditEvent = { ...event, ...(event.meta ? { meta: safeMeta(event.meta) } : {}) };
    this.tail = this.tail.then(async() => {
      await this.ready;
      this.pending.push(safe);
      this.trimSpool();
      await this.flush();
    }).catch(() => undefined);
  }

  private trimSpool(): void {
    while (this.pending.length > MAX_SPOOL_EVENTS) {
      this.pending.shift();
      this.droppedCount++;
    }
  }

  private async flush(): Promise<void> {
    while (this.pending.length) {
      try {
        await this.send(this.pending[0]);
        this.pending.shift();
      } catch {
        await this.writeSpool(this.pending);
        return;
      }
    }

    if (this.droppedCount) {
      const dropped = this.droppedCount;
      const notice: VaultAuditEvent = {
        subjectKind: 'vault-secret',
        subjectId: '_spool',
        action: 'audit_events_dropped',
        actor: 'sulla-vault',
        result: 'dropped',
        meta: { count: String(dropped) },
      };
      this.droppedCount = 0;
      try {
        await this.send(notice);
      } catch {
        this.pending.unshift(notice);
        await this.writeSpool(this.pending);
        return;
      }
    }

    await this.clearSpool();
  }

  private async send(event: VaultAuditEvent): Promise<void> {
    if (!this.config.filesServiceToken || !this.endpoint) throw new Error('Files audit is unavailable');
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sulla-files-token': this.config.filesServiceToken },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Files audit returned ${ response.status }`);
  }

  private async loadSpool(): Promise<void> {
    try {
      const raw = await readFile(this.spoolPath, 'utf8');
      this.pending = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as VaultAuditEvent);
      this.trimSpool();
    } catch { /* no spool exists or it could not be loaded */ }
  }

  private async writeSpool(events: VaultAuditEvent[]): Promise<void> {
    await mkdir(dirname(this.spoolPath), { recursive: true, mode: 0o700 });
    const temp = `${ this.spoolPath }.tmp`;
    await writeFile(temp, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    await rename(temp, this.spoolPath);
  }

  private async clearSpool(): Promise<void> {
    try { await unlink(this.spoolPath); } catch { /* no spool exists */ }
  }
}
