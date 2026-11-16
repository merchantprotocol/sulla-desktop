// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';
import { basename, posix } from 'node:path';

import { FilesCloudBroker } from './cloudBroker.js';
import { ShareLinkRepository, type ShareQueryable } from './Repositories/ShareLinkRepository.js';
import { ShareCloudGateway, type ShareCloudBroker } from './Services/ShareCloudGateway.js';
import { ShareContentReader, type ShareStreamContent } from './Services/ShareContentReader.js';
import { ShareLinkLock } from './Services/ShareLinkLock.js';
import { SharePasswordHasher } from './Services/SharePasswordHasher.js';

import type { Config } from './config.js';
import type { Store } from './store.js';
import type pg from 'pg';

interface Identity { user: string; device: string }
interface ShareInput {
  fileId?:          string;
  collectionId?:    string;
  folderPath?:      string;
  accessMode?:      'view' | 'download';
  permission?:      'view' | 'download';
  password?:        string;
  expiresAt?:       string | null;
  keepAvailable?:   boolean;
  keepUntil?:       string | null;
  displaySharerName?: boolean;
  assetKind?:       'file' | 'capture' | 'artifact';
  captureMetadata?: Record<string, unknown>;
  deviceId?:        string;
}

interface ShareAccessRequest { password?: string; wantsDownload?: boolean }
type Queryable = ShareQueryable;

/** Collaborators a composition root (or a spec) may supply instead of the defaults. */
export interface SharesServiceDependencies {
  cloudBroker?: ShareCloudBroker;
  links?:       ShareLinkRepository;
  passwords?:   SharePasswordHasher;
}

/**
 * Public share links: create, list, update, revoke, restore, public access checks and content.
 * SQL lives in ShareLinkRepository; Cloud calls in ShareCloudGateway; content reads in ShareContentReader.
 */
export class SharesService {
  private readonly links:ShareLinkRepository;
  private readonly passwords:SharePasswordHasher;
  private readonly remote:ShareCloudGateway;
  private readonly linkLock:ShareLinkLock;
  private readonly reader:ShareContentReader;

  constructor(private db: pg.Pool, private config: Config, private store: Store, dependencies:SharesServiceDependencies = {}) {
    const broker = dependencies.cloudBroker ?? (config.mode === 'desktop' && config.vaultBrokerServiceToken ? new FilesCloudBroker(config) : undefined);
    this.links = dependencies.links ?? new ShareLinkRepository(db);
    this.passwords = dependencies.passwords ?? new SharePasswordHasher();
    this.remote = new ShareCloudGateway(broker);
    this.linkLock = new ShareLinkLock(db, this.links);
    this.reader = new ShareContentReader(db, config, store, this.links);
  }

  private withLinkLock<T>(id:string, operation:(client:pg.PoolClient)=>Promise<T>):Promise<T> { return this.linkLock.run(id, operation) }

  private deleteRemote(id:string):Promise<boolean> { return this.remote.deleteRemote(id) }

  private persistRemoteDeleteState(id:string, pending:boolean, queryable:Queryable = this.db):Promise<void> {
    return this.links.persistRemoteDeleteState(id, pending, queryable);
  }

  private async reconcilePendingDeletes(identity:Identity):Promise<void> {
    const pending = await this.links.pendingDeleteIds(identity.user);
    // Bound reconciliation to one lock/client at a time. This runs during list,
    // so a small pool must retain capacity for unrelated requests.
    for (const { id } of pending) {
      await this.withLinkLock(String(id), async(client) => {
        const current = await this.links.reconciliationState(client, String(id), identity.user);
        if (!current?.reconciliation_required || current.reconciliation_action !== 'delete') return;
        if (await this.deleteRemote(String(id))) await this.persistRemoteDeleteState(String(id), false, client);
      });
    }
  }

  private folderPath(value: unknown): string {
    const normalized = posix.normalize(String(value ?? '').replace(/^\/+/, '')).replace(/\/$/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw Object.assign(new Error('valid folderPath required'), { status: 400 });
    return normalized;
  }

  async create(identity: Identity, input: ShareInput, _cloudToken?: string) {
    const assetKind = input.assetKind === 'capture' ? 'capture' : input.assetKind === 'artifact' ? 'artifact' : 'file';
    const accessMode = input.permission === 'download' || input.accessMode === 'download' ? 'download' : 'view';
    const deviceId = this.config.deviceId || identity.device;
    const keepAvailable = input.keepAvailable ?? assetKind === 'capture';
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const keepUntil = input.keepUntil ? new Date(input.keepUntil) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
    if (keepUntil && (!Number.isFinite(keepUntil.getTime()) || keepUntil.getTime() <= Date.now())) throw Object.assign(new Error('keepUntil must be in the future'), { status: 400 });
    if (keepUntil && expiresAt && keepUntil > expiresAt) throw Object.assign(new Error('keepUntil cannot be later than link expiry'), { status: 400 });
    if (input.password !== undefined && (input.password.length < 8 || input.password.length > 256)) throw Object.assign(new Error('password must be 8 to 256 characters'), { status: 400 });
    let targetType: 'file' | 'folder'; let fileId: string | null = null; let collectionId: string; let folderPath: string | null = null; let name: string; let mime: string;
    if (input.fileId) {
      const target = await this.links.findShareableFile(input.fileId);
      if (!target) throw Object.assign(new Error('file not found'), { status: 404 });
      ({ id: fileId, collection_id: collectionId, mime } = target); name = basename(target.path); targetType = 'file';
    } else {
      if (!input.collectionId) throw Object.assign(new Error('fileId or collectionId + folderPath required'), { status: 400 });
      collectionId = input.collectionId; folderPath = this.folderPath(input.folderPath); name = basename(folderPath); mime = 'application/json'; targetType = 'folder';
      if (keepAvailable) throw Object.assign(new Error('keepAvailable is only supported for files'), { status: 400 });
    }
    const id = randomBytes(12).toString('base64url'); const source = 'desktop';
    return this.withLinkLock(id, async(client) => {
      // The row starts revoked with a durable delete intent. If this process dies
      // after Cloud commits the POST, the next authenticated reconciliation removes it.
      await this.links.insertPendingLink(client,
        [id, identity.user, targetType, fileId, targetType === 'folder' ? collectionId : null, folderPath, name, mime, accessMode, Boolean(input.password), input.password ? this.passwords.hash(input.password) : null, expiresAt?.toISOString() ?? null, keepAvailable, keepUntil?.toISOString() ?? null, input.displaySharerName ?? true, source, deviceId, assetKind, input.captureMetadata ?? {}]);
      await this.links.recordEvent(client, id, 'created', `${ accessMode } access`);
      try {
        const cloud = await this.cloud(`/shares`, {
          method: 'POST',
          body:   JSON.stringify({
            id,
            targetType,
            name,
            mime,
            accessMode,
            password:        input.password,
            expiresAt:       expiresAt?.toISOString(),
            keepAvailable,
            keepUntil:       keepUntil?.toISOString(),
            displaySharerName: input.displaySharerName ?? true,
            servedFrom:      source,
            deviceId,
            assetKind,
            captureMetadata: input.captureMetadata ?? {},
          }),
        });
        this.remote.assertPolicy(cloud, {
          accessMode,
          passwordProtected: Boolean(input.password),
          expiresAt:          expiresAt?.toISOString() ?? null,
          keepAvailable,
          keepUntil:          keepUntil?.toISOString() ?? null,
          displaySharerName:  input.displaySharerName ?? true,
        });
        if (keepAvailable) await this.upload(id, client, true);
        await this.links.markRegistered(client, id, cloud.url, keepAvailable ? 'cloud' : source);
        return this.safeRow(identity, id, client);
      } catch (error) {
        const deleted = await this.deleteRemote(id);
        if (deleted) await this.links.delete(client, id);
        else await this.persistRemoteDeleteState(id, true, client);
        throw error;
      }
    });
  }

  async list(identity: Identity, _cloudToken?: string) {
    if (this.remote.available) {
      try {
        await this.reconcilePendingDeletes(identity);
        const local = await this.links.listOwned(identity.user);
        const cloud = await this.cloud('/shares'); const values = Array.isArray(cloud) ? cloud : cloud.shares ?? cloud.links ?? [];
        const remote = new Map(values.map((item:any) => [String(item.id ?? item.token), this.remote.overlay(item)]));
        return local.map(item => {
          const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item;
          const overlay:Record<string, unknown> = { ...(remote.get(String(item.id)) ?? {}) };
          if (item.revoked_at || item.reconciliation_required) delete overlay.revoked_at;
          return { ...safe, ...overlay, id: item.id };
        });
      } catch { /* offline list falls through */ }
    }
    const local = await this.links.listOwned(identity.user);
    return local.map(item => { const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item; return safe });
  }

  private async getRow(identity:Identity, id:string, queryable:Queryable = this.db) {
    const row = await this.links.findOwned(queryable, id, identity.user);
    if (!row) throw Object.assign(new Error('share not found'), { status: 404 }); return row;
  }

  private async safeRow(identity:Identity, id:string, queryable:Queryable) {
    const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = await this.getRow(identity, id, queryable);
    return safe;
  }

  async get(identity: Identity, id: string) { return this.safeRow(identity, id, this.db) }

  async revoke(identity: Identity, id: string, _cloudToken?: string) {
    return this.withLinkLock(id, async(client) => {
      await this.getRow(identity, id, client);
      await this.persistRemoteDeleteState(id, true, client);
      const deleted = await this.deleteRemote(id);
      await this.persistRemoteDeleteState(id, !deleted, client);
      await this.links.recordEvent(client, id, 'revoked');
      if (!deleted) throw Object.assign(new Error('Local access is disabled; remote deletion could not be confirmed and is queued for retry'), { status: 502 });
      return { ok: true };
    });
  }

  async update(identity: Identity, id: string, input:ShareInput, _cloudToken?: string) {
    return this.withLinkLock(id, async(client) => {
      const row = await this.getRow(identity, id, client); if (row.revoked_at) throw Object.assign(new Error('revoked links must be restored before editing'), { status: 409 });
      const mode = input.permission === 'download' || input.accessMode === 'download' ? 'download' : input.accessMode === 'view' || input.permission === 'view' ? 'view' : row.access_mode;
      const enabled = input.keepAvailable ?? row.keep_available; if (row.target_type !== 'file' && enabled) throw Object.assign(new Error('folder copies are not supported'), { status: 400 });
      const expiresAt = input.expiresAt === undefined ? row.expires_at : input.expiresAt ? new Date(input.expiresAt) : null;
      const keepUntil = input.keepUntil === undefined ? row.keep_until : input.keepUntil ? new Date(input.keepUntil) : null;
      if (expiresAt && (!Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= Date.now())) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
      if (keepUntil && (!Number.isFinite(new Date(keepUntil).getTime()) || new Date(keepUntil).getTime() <= Date.now())) throw Object.assign(new Error('keepUntil must be in the future'), { status: 400 });
      if (keepUntil && expiresAt && new Date(keepUntil) > new Date(expiresAt)) throw Object.assign(new Error('keepUntil cannot be later than link expiry'), { status: 400 });
      if (input.password !== undefined && input.password && (input.password.length < 8 || input.password.length > 256)) throw Object.assign(new Error('password must be 8 to 256 characters'), { status: 400 });
      const passwordProtected = input.password === undefined ? row.password_protected : Boolean(input.password);
      const encodedPassword = input.password === undefined ? row.password_hash : input.password ? this.passwords.hash(input.password) : null;
      // Disable local access and persist cleanup intent before either remote
      // mutation. Cloud requires keepAvailable=true before accepting content.
      await this.links.markUpdatePending(client, id);
      try {
        const cloud = await this.cloud(`/shares/${ encodeURIComponent(id) }`, { method: 'PATCH', body: JSON.stringify({ accessMode: mode, password: input.password, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, keepAvailable: enabled, keepUntil: keepUntil ? new Date(keepUntil).toISOString() : null, displaySharerName: input.displaySharerName ?? row.display_sharer_name }) });
        this.remote.assertPolicy(cloud, {
          accessMode:        mode,
          passwordProtected,
          passwordChanged:  input.password !== undefined,
          expiresAt:         expiresAt ? new Date(expiresAt).toISOString() : null,
          keepAvailable:     enabled,
          keepUntil:         keepUntil ? new Date(keepUntil).toISOString() : null,
          displaySharerName: input.displaySharerName ?? row.display_sharer_name,
        });
        if (enabled && !row.keep_available) await this.upload(id, client, true);
        await this.links.applyPolicy(client, [id, mode, passwordProtected, encodedPassword, expiresAt ? new Date(expiresAt).toISOString() : null, enabled, keepUntil ? new Date(keepUntil).toISOString() : null, input.displaySharerName ?? row.display_sharer_name, enabled ? 'cloud' : 'desktop']);
        await this.links.recordEvent(client, id, 'updated', `${ mode } access`);
        return this.safeRow(identity, id, client);
      } catch (error) {
        // A partially-applied policy must never leave the local relay reachable.
        const deleted = await this.deleteRemote(id);
        await this.persistRemoteDeleteState(id, !deleted, client);
        const state = deleted ? 'local access was disabled' : 'local access was disabled and remote deletion is queued because it could not be confirmed';
        throw Object.assign(new Error(`Share settings could not be reconciled; ${ state }: ${ error instanceof Error ? error.message : String(error) }`), { status: 502 });
      }
    });
  }

  async restore(identity:Identity, id:string, cloudTokenOrPassword?:string, password?:string) {
    const restorePassword = password ?? cloudTokenOrPassword;
    return this.withLinkLock(id, async(client) => {
      const row = await this.getRow(identity, id, client); if (!row.revoked_at) return this.safeRow(identity, id, client);
      if (row.password_protected && (!restorePassword || !row.password_hash || !this.passwords.matches(restorePassword, row.password_hash))) throw Object.assign(new Error('Re-enter the link password to restore this protected share'), { status: 401 });
      if (row.reconciliation_required) {
        if (!await this.deleteRemote(id)) throw Object.assign(new Error('The prior remote link deletion is still pending; restore is blocked until it can be confirmed'), { status: 502 });
      }
      // Keep (or establish) delete intent until the replacement publication is
      // fully verified. A lost POST response is therefore always recoverable.
      await this.persistRemoteDeleteState(id, true, client);
      try {
        const cloud = await this.cloud('/shares', { method: 'POST', body: JSON.stringify({ id, targetType: row.target_type, name: row.display_name, mime: row.mime, accessMode: row.access_mode, password: row.password_protected ? restorePassword : undefined, expiresAt: row.expires_at, keepAvailable: false, keepUntil: null, displaySharerName: row.display_sharer_name, servedFrom: 'desktop', deviceId: row.device_id, assetKind: row.asset_kind, captureMetadata: row.capture_metadata }) });
        this.remote.assertPolicy(cloud, {
          accessMode:        row.access_mode,
          passwordProtected: Boolean(row.password_protected),
          expiresAt:         row.expires_at,
          keepAvailable:     false,
          keepUntil:         null,
          displaySharerName: Boolean(row.display_sharer_name),
        });
        await this.links.markRestored(client, id, cloud.url);
        await this.links.recordEvent(client, id, 'created', 'restored'); return this.safeRow(identity, id, client);
      } catch (error) {
        const deleted = await this.deleteRemote(id);
        await this.persistRemoteDeleteState(id, !deleted, client);
        throw error;
      }
    });
  }

  async activity(identity:Identity, id?:string) {
    return this.links.activity(identity.user, id);
  }

  async authorize(id:string, request:ShareAccessRequest) {
    const row = await this.links.findById(id);
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (row.password_protected && (!request.password || !row.password_hash || !this.passwords.matches(request.password, row.password_hash))) throw Object.assign(new Error('password required or invalid'), { status: 401 });
    if (request.wantsDownload && row.access_mode !== 'download') throw Object.assign(new Error('download is not allowed'), { status: 403 });
    const action = request.wantsDownload ? 'downloaded' : 'viewed';
    await this.links.recordView(id);
    await this.links.recordEvent(this.db, id, action);
    return { id: row.id, name: row.display_name, mime: row.mime, mode: row.access_mode, targetType: row.target_type, displaySharerName: row.display_sharer_name };
  }

  async content(id: string, requestedPath = ''): Promise<{ bytes: Buffer; mime: string; name: string }> {
    return this.readContent(id, requestedPath, false, this.db);
  }

  async streamContent(id:string, requestedPath:string, rangeHeader:string | undefined, signal:AbortSignal):Promise<ShareStreamContent> {
    return this.reader.stream(id, requestedPath, rangeHeader, signal);
  }

  private readContent(id:string, requestedPath:string, allowPendingPublication:boolean, queryable:Queryable):Promise<{ bytes:Buffer; mime:string; name:string }> {
    return this.reader.read(id, requestedPath, allowPendingPublication, queryable);
  }

  private async upload(id:string, queryable:Queryable, allowPendingPublication = false) {
    const content = await this.readContent(id, '', allowPendingPublication, queryable); await this.cloud(`/shares/${ encodeURIComponent(id) }/content`, {
      method: 'PUT', headers: { 'Content-Type': content.mime, 'X-Sulla-Filename': encodeURIComponent(content.name) }, body: new Uint8Array(content.bytes),
    });
  }

  private cloud(path: string, init: RequestInit = {}, acceptedStatuses:number[] = []):Promise<any> {
    return this.remote.request(path, init, acceptedStatuses);
  }
}
