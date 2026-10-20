import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { VaultConfig } from './config.js';

const FORBIDDEN_META = /(?:^|_|-)(?:value|secret|password|token)(?:$|_|-)/i;
const DEFAULT_FILES_API = 'https://sulla_files:8792';
const AUDIT_SPOOL = 'vault-audit-spool.jsonl';

export interface VaultAuditEvent {
  subjectKind: 'vault-secret'; subjectId: string; action: string; actor: string; result: string;
  requestId?: string; path?: string; meta?: Record<string, string>;
}

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
  private readonly endpoint: string;
  private readonly spoolPath: string;

  constructor(private readonly config: VaultConfig, fetcher: typeof fetch = fetch) {
    this.endpoint = (config.filesApiUrl ?? DEFAULT_FILES_API).replace(/\/+$/, '') + '/v1/system/audit-events';
    this.spoolPath = join(config.auditSpoolDir ?? '/var/lib/sulla-vault', AUDIT_SPOOL);
    this.fetcher = fetcher;
  }

  private readonly fetcher: typeof fetch;

  emit(event: VaultAuditEvent): void {
    const safe: VaultAuditEvent = { ...event, ...(event.meta ? { meta: safeMeta(event.meta) } : {}) };
    this.tail = this.tail.then(async() => {
      const pending = await this.readSpool();
      const events = [...pending, safe];
      try {
        for (const item of events) await this.send(item);
        await this.clearSpool();
      } catch {
        await this.writeSpool(events);
      }
    }).catch(() => undefined);
  }

  private async send(event: VaultAuditEvent): Promise<void> {
    if (!this.config.filesServiceToken) throw new Error('Files audit token is unavailable');
    const response = await this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sulla-files-token': this.config.filesServiceToken },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Files audit returned ${ response.status }`);
  }

  private async readSpool(): Promise<VaultAuditEvent[]> {
    try {
      const raw = await readFile(this.spoolPath, 'utf8');
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as VaultAuditEvent);
    } catch { return []; }
  }

  private async writeSpool(events: VaultAuditEvent[]): Promise<void> {
    await mkdir(dirname(this.spoolPath), { recursive: true, mode: 0o700 });
    const temp = `${ this.spoolPath }.tmp`;
    await writeFile(temp, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    await rename(temp, this.spoolPath);
  }

  private async clearSpool(): Promise<void> {
    try { await writeFile(this.spoolPath, '', { mode: 0o600 }); } catch { /* no spool exists */ }
  }
}
