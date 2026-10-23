/**
 * Fulfills the web Files screen's two device-only actions — preview/download
 * a file's bytes, or mint a public link — without the browser ever holding
 * a device signature. Polls `GET /cloud-files/v1/catalog/:deviceId/desktop-
 * requests` through the same vault-broker path catalogSync.ts uses, then
 * fulfills each request through code the local File Manager UI already
 * exercises: streamFileContent (permission/size-checked local read) for
 * content, SharesService.create (the exact path a local "Copy link" click
 * takes, including its own call back to Cloud's POST /shares) for links.
 *
 * Catalog ids for files are `cf_<local file id>` (see catalogSync.ts's
 * buildCollectionItems), so the local file is recovered by stripping that
 * prefix — no extra id-mapping storage needed.
 */

import { FilesCloudBroker } from '../cloudBroker.js';
import { streamFileContent } from '../fileStream.js';

import type { Config } from '../config.js';
import type { SharesService } from '../shares.js';
import type { Store } from '../store.js';
import type pg from 'pg';

const POLL_INTERVAL_MS = 15_000;
const MAX_REQUESTS_PER_TICK = 20;
export const CONTENT_REQUEST_MAX_BYTES = 5 * 1024 * 1024;

interface PendingRequest { id: string; kind: 'content' | 'link'; catalogId: string; accessMode?: 'view' | 'download' | null }

function localFileId(catalogId: string): string | null {
  return catalogId.startsWith('cf_') ? catalogId.slice(3) : null;
}

export class DesktopRequestSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly broker?: FilesCloudBroker;
  private readonly cloudDeviceId?: string;
  private ticking = false;

  constructor(private readonly db: pg.Pool, private readonly config: Config, private readonly store: Store, private readonly shares: SharesService) {
    this.cloudDeviceId = process.env.SULLA_FILES_CLOUD_DEVICE_ID?.trim() || undefined;
    this.broker = config.mode === 'desktop' && config.vaultBrokerServiceToken && this.cloudDeviceId ? new FilesCloudBroker(config) : undefined;
  }

  start(): void {
    if (this.timer || !this.broker) return;
    this.timer = setInterval(() => { this.tick().catch(() => undefined) }, POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.tick().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.broker || this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.cloud(`/cloud-files/v1/catalog/${ encodeURIComponent(this.cloudDeviceId as string) }/desktop-requests`, 'GET');
      const requests = result && typeof result === 'object' && Array.isArray((result as { requests?: unknown }).requests)
        ? (result as { requests: PendingRequest[] }).requests : [];
      for (const request of requests.slice(0, MAX_REQUESTS_PER_TICK)) {
        try {
          if (request.kind === 'content') await this.fulfillContent(request);
          else await this.fulfillLink(request);
        } catch (error) {
          await this.fail(request.id, error);
        }
      }
    } catch {
      // Signed out or offline — the next tick retries; nothing to report locally.
    } finally {
      this.ticking = false;
    }
  }

  private async fulfillContent(request: PendingRequest): Promise<void> {
    const fileId = localFileId(request.catalogId);
    if (!fileId) throw new Error('that catalog entry is not a file');
    const owned = (await this.db.query(
      `SELECT f.id FROM files f JOIN collections c ON c.id = f.collection_id
        WHERE f.id = $1 AND f.deleted_at IS NULL AND c.owner_user_id = $2 AND c.cloud_catalog_sync = TRUE`,
      [fileId, this.config.userId],
    )).rows[0];
    if (!owned) throw new Error('file not found or no longer shown in Sulla Cloud');
    const content = await streamFileContent(this.db, this.config, this.store, fileId, undefined, undefined, new AbortController().signal);
    if (!content) throw new Error('this file has no readable version');
    if (content.size > CONTENT_REQUEST_MAX_BYTES) throw new Error('this file exceeds the 5MB preview limit');
    const chunks: Buffer[] = [];
    for await (const part of content.body) chunks.push(part);
    await this.cloud(
      `/cloud-files/v1/catalog/${ encodeURIComponent(this.cloudDeviceId as string) }/desktop-requests/${ encodeURIComponent(request.id) }/content`,
      'PUT', new Uint8Array(Buffer.concat(chunks)), content.mime || 'application/octet-stream',
    );
  }

  private async fulfillLink(request: PendingRequest): Promise<void> {
    const fileId = localFileId(request.catalogId);
    if (!fileId) throw new Error('that catalog entry is not a file');
    const created = await this.shares.create(
      { user: this.config.userId, device: this.config.deviceId },
      { fileId, accessMode: request.accessMode === 'download' ? 'download' : 'view' },
    );
    const linkId = (created as { id?: string }).id;
    if (!linkId) throw new Error('Sulla Cloud did not confirm the new link');
    await this.cloud(
      `/cloud-files/v1/catalog/${ encodeURIComponent(this.cloudDeviceId as string) }/desktop-requests/${ encodeURIComponent(request.id) }/link`,
      'POST', JSON.stringify({ linkId }), 'application/json',
    );
  }

  private async fail(requestId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.cloud(
        `/cloud-files/v1/catalog/${ encodeURIComponent(this.cloudDeviceId as string) }/desktop-requests/${ encodeURIComponent(requestId) }/fail`,
        'POST', JSON.stringify({ error: message }), 'application/json',
      );
    } catch { /* best effort — the request expires on the Cloud side on its own */ }
  }

  private async cloud(path: string, method: string, body?: string | Uint8Array, contentType?: string): Promise<unknown> {
    if (!this.broker) throw Object.assign(new Error('Sulla Cloud broker is unavailable'), { status: 503 });
    const result = await this.broker.execute(path, method, body, contentType);
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`Sulla Cloud returned ${ result.status }`), { status: 502 });
    return result.body;
  }
}
