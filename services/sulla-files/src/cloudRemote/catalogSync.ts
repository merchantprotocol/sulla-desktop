/**
 * Pushes a searchable index of this device's "synced" collections to Sulla
 * Cloud, powering the Cloud web Files screen's My Files list. Only
 * metadata — path, name, mime, size, modified time — ever leaves the
 * device; file bytes stay local until the owner explicitly shares one
 * (see shares.ts's FilesCloudBroker use, which this mirrors).
 *
 * Opt-in is per collection and OFF by default: `cloud_catalog_sync` is a
 * column separate from `home` (which governs device-local sync, not what
 * Sulla Cloud sees). The File Manager's "Show in Sulla Cloud" toggle is
 * the only thing that flips it.
 *
 * Calls go through FilesCloudBroker, the same vault-broker-mediated path
 * shares.ts already uses: this service process has no access to the
 * device's Ed25519 private key (that lives in the Electron main process
 * keystore), so PUT /cloud-files/v1/catalog/:deviceId is authenticated by
 * the signed-in user's bearer token, not a device signature.
 */

import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';

import type pg from 'pg';

import { FilesCloudBroker } from '../cloudBroker.js';
import { isProtectedPath } from '../protectedFiles.js';

import type { Config } from '../config.js';

const INTERVAL_MS = 10 * 60_000;
const MAX_ITEMS = 5000;

export interface CatalogSyncStatus {
  lastSyncAt?: string;
  lastError?:  string;
  itemCount?:  number;
}

interface CatalogItem {
  id:          string;
  kind:        'file' | 'folder';
  name:        string;
  path:        string;
  parentPath:  string;
  mime?:       string | null;
  sizeBytes?:  number | null;
  modifiedAt?: string | null;
}

interface FileRow {
  id:         string;
  path:       string;
  mime:       string | null;
  size:       string | number | null;
  updated_at: string;
}

interface CollectionRow {
  id:   string;
  name: string;
}

function folderId(collectionId: string, folderPath: string): string {
  return `cff_${ createHash('sha256').update(`${ collectionId }:${ folderPath }`).digest('hex').slice(0, 32) }`;
}

/** Builds file + synthesized-folder catalog items for one collection. Exported for tests. */
/** Collections the owner explicitly showed in Sulla Cloud ($1 = owner user id). Never the audit logs area. */
export const CLOUD_VISIBLE_COLLECTION = `owner_user_id = $1 AND cloud_catalog_sync = TRUE AND published = TRUE AND legacy_source = FALSE AND system_area IS DISTINCT FROM 'logs'`;

export function buildCollectionItems(collection: CollectionRow, files: FileRow[]): CatalogItem[] {
  const items: CatalogItem[] = [];
  const folders = new Map<string, string>(); // folderPath -> parentPath

  const ensureFolder = (folderPath: string, parentPath: string) => {
    if (folders.has(folderPath)) return;
    folders.set(folderPath, parentPath);
  };
  ensureFolder(collection.name, '');

  for (const file of files) {
    const fullPath = `${ collection.name }/${ file.path }`;
    const name = basename(file.path) || file.path;
    const parentDir = dirname(fullPath); // always under collection.name since fullPath is prefixed with it

    // Walk every intermediate directory level so breadcrumb navigation works.
    let cursor = parentDir;
    while (cursor && cursor !== '.' && cursor !== collection.name) {
      const parent = dirname(cursor) === '.' ? collection.name : dirname(cursor);
      ensureFolder(cursor, parent);
      cursor = parent;
    }

    items.push({
      id: `cf_${ file.id }`, kind: 'file', name, path: fullPath, parentPath: parentDir,
      mime: file.mime, sizeBytes: file.size === null ? null : Number(file.size),
      modifiedAt: file.updated_at,
    });
  }

  for (const [folderPath, parentPath] of folders) {
    items.push({
      id: folderId(collection.id, folderPath), kind: 'folder', name: basename(folderPath) || folderPath,
      path: folderPath, parentPath,
    });
  }
  return items;
}

export class CatalogSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly broker?: FilesCloudBroker;
  private readonly cloudDeviceId?: string;
  private status: CatalogSyncStatus = {};
  private inFlight: Promise<CatalogSyncStatus> | null = null;

  constructor(private readonly db: pg.Pool, private readonly config: Config) {
    // The Cloud only accepts a push for a device id it registered; config.deviceId is the hostname.
    this.cloudDeviceId = process.env.SULLA_FILES_CLOUD_DEVICE_ID?.trim() || undefined;
    this.broker = config.mode === 'desktop' && config.vaultBrokerServiceToken && this.cloudDeviceId ? new FilesCloudBroker(config) : undefined;
  }

  start(): void {
    if (this.timer || !this.broker) return;
    this.timer = setInterval(() => { this.syncNow().catch(() => undefined) }, INTERVAL_MS);
    this.timer.unref?.();
    this.syncNow().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus(): CatalogSyncStatus {
    return this.status;
  }

  syncNow(): Promise<CatalogSyncStatus> {
    if (this.inFlight) return this.inFlight;
    const run = this.run().finally(() => { this.inFlight = null });
    this.inFlight = run;
    return run;
  }

  private async run(): Promise<CatalogSyncStatus> {
    if (!this.broker) return this.status;
    try {
      const collections = (await this.db.query<CollectionRow>(
        `SELECT id, name FROM collections WHERE ${ CLOUD_VISIBLE_COLLECTION } ORDER BY created_at`,
        [this.config.userId],
      )).rows;

      const items: CatalogItem[] = [];
      for (const collection of collections) {
        if (items.length >= MAX_ITEMS) break;
        const files = (await this.db.query<FileRow>(
          `SELECT id, path, mime, size, updated_at FROM files
            WHERE collection_id = $1 AND deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM files_protected_files p WHERE p.file_id = files.id)
            ORDER BY path LIMIT $2`,
          [collection.id, MAX_ITEMS - items.length],
        )).rows;
        // Protected files (vaults, wallets, master keys) never reach Cloud, not even by name.
        items.push(...buildCollectionItems(collection, files.filter(file => !isProtectedPath(file.path))));
      }

      await this.cloud(`/cloud-files/v1/catalog/${ encodeURIComponent(this.cloudDeviceId as string) }`, {
        method: 'PUT',
        body: JSON.stringify({ items: items.slice(0, MAX_ITEMS), fullSnapshot: true }),
      });

      this.status = { lastSyncAt: new Date().toISOString(), itemCount: items.length };
      return this.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = { ...this.status, lastError: message };
      return this.status;
    }
  }

  private async cloud(path: string, init: { method: string; body?: string }): Promise<unknown> {
    if (!this.broker) throw Object.assign(new Error('Sulla Cloud broker is unavailable'), { status: 503 });
    const result = await this.broker.execute(path, init.method, init.body, init.body ? 'application/json' : undefined);
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`Sulla Cloud returned ${ result.status }`), { status: 502 });
    return result.body;
  }
}
