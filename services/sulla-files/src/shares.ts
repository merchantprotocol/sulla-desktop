import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { basename, posix } from 'node:path';

import { decryptChunk } from './crypto.js';
import { parseByteRange, RangeNotSatisfiableError, streamFileContent } from './fileStream.js';
import { assertUnprotectedFile, isProtectedPath } from './protectedFiles.js';

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
type Queryable = Pick<pg.Pool, 'query'>;
interface ShareStreamContent {
  body:          AsyncIterable<Buffer>;
  mime:          string;
  name:          string;
  status:        200 | 206;
  contentLength: number;
  contentRange?: string;
}

function passwordHash(password:string):string {
  const salt = randomBytes(16); const digest = scryptSync(password, salt, 32);
  return `${ salt.toString('base64url') }:${ digest.toString('base64url') }`;
}

function passwordMatches(password:string, encoded:string):boolean {
  const [salt, expected] = encoded.split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), 32); const expectedBytes = Buffer.from(expected, 'base64url');
  return actual.length === expectedBytes.length && timingSafeEqual(actual, expectedBytes);
}

function remoteShareOverlay(value:unknown):Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const remote = value as Record<string, unknown>; const safe:Record<string, unknown> = {};
  const copy = (target:string, ...sources:string[]) => {
    const source = sources.find(key => remote[key] !== undefined);
    if (source) safe[target] = remote[source];
  };

  copy('public_url', 'url', 'public_url', 'publicUrl');
  copy('view_count', 'viewCount', 'view_count', 'views');
  copy('last_viewed_at', 'lastViewedAt', 'last_viewed_at');
  copy('expires_at', 'expiresAt', 'expires_at');
  copy('keep_available', 'keepAvailable', 'keep_available');
  copy('keep_until', 'keepUntil', 'keep_until');
  copy('display_sharer_name', 'displaySharerName', 'display_sharer_name');
  copy('served_from', 'servedFrom', 'served_from');
  copy('access_mode', 'accessMode', 'access_mode');
  copy('revoked_at', 'revokedAt', 'revoked_at');

  return safe;
}

class ServerShareRelay {
  private socket?:    WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private requests = new Map<string, AbortController>();

  constructor(private db: pg.Pool, private config: Config, private content: (id: string, path: string, range: string | undefined, signal: AbortSignal) => Promise<ShareStreamContent>) {}

  connect(): void {
    if (this.config.mode !== 'server' || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.open().catch(error => { console.warn('[SullaFiles] server share relay failed', error); this.retry() });
  }

  private async open(): Promise<void> {
    const row = (await this.db.query(`SELECT id,relay_secret FROM file_share_links
      WHERE relay_secret IS NOT NULL AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())
      ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!row) return;
    const url = new URL(`/share-relay/${ encodeURIComponent(row.id) }`, this.config.cloudUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.searchParams.set('secret', row.relay_secret);
    const socket = new WebSocket(url); this.socket = socket;
    socket.addEventListener('message', event => this.handle(String(event.data)).catch(error => console.warn('[SullaFiles] share relay request failed', error)));
    socket.addEventListener('close', () => { if (this.socket === socket) this.socket = undefined; this.retry() });
    socket.addEventListener('error', () => socket.close());
  }

  private retry(): void {
    if (this.reconnect) return;
    this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect() }, 5_000);
  }

  private async handle(raw: string): Promise<void> {
    let frame: any; try { frame = JSON.parse(raw) } catch { return }
    if (frame.type === 'share_fetch_cancel' && typeof frame.requestId === 'string') {
      this.requests.get(frame.requestId)?.abort();
      return;
    }
    if (frame.type !== 'share_fetch' || typeof frame.requestId !== 'string' || typeof frame.linkId !== 'string') return;
    const send = (type: string, payload: Record<string, unknown> = {}) => this.socket?.send(JSON.stringify({ type, requestId: frame.requestId, ...payload }));
    this.requests.get(frame.requestId)?.abort();
    const controller = new AbortController(); this.requests.set(frame.requestId, controller);
    try {
      const content = await this.content(frame.linkId, typeof frame.path === 'string' ? frame.path : '', typeof frame.range === 'string' ? frame.range : undefined, controller.signal);
      send('share_fetch_start', { status: content.status, mime: content.mime, name: content.name, contentLength: content.contentLength, contentRange: content.contentRange, acceptRanges: 'bytes' });
      for await (const part of content.body) {
        controller.signal.throwIfAborted();
        for (let offset = 0; offset < part.length; offset += 64 * 1024) send('share_fetch_chunk', { data: part.subarray(offset, offset + 64 * 1024).toString('base64') });
      }
      send('share_fetch_end');
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) {
        send('share_fetch_start', { status: 416, contentLength: 0, contentRange: `bytes */${ error.size }`, acceptRanges: 'bytes' });
        send('share_fetch_end');
      } else if (!controller.signal.aborted) send('share_fetch_error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.requests.get(frame.requestId) === controller) this.requests.delete(frame.requestId);
    }
  }
}

export class SharesService {
  private serverRelay?: ServerShareRelay;
  private readonly linkLocks = new Map<string, Promise<void>>();

  constructor(private db: pg.Pool, private config: Config, private store: Store) {
    if (config.mode === 'server') { this.serverRelay = new ServerShareRelay(db, config, (id, path, range, signal) => this.streamContent(id, path, range, signal)); this.serverRelay.connect() }
  }

  private async withLinkLock<T>(id:string, operation:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
    const previous = this.linkLocks.get(id) ?? Promise.resolve();
    let release:()=>void = () => {};
    const current = new Promise<void>(resolve => { release = resolve });
    const tail = previous.then(() => current);

    this.linkLocks.set(id, tail);
    await previous;
    let client:pg.PoolClient | undefined;
    let databaseLockHeld = false;
    let operationFailed = false; let operationError:unknown; let result:T | undefined;
    try {
      client = await this.db.connect();
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [id]);
      databaseLockHeld = true;
      result = await operation(client);
    } catch (error) { operationFailed = true; operationError = error }
    let unlockError:Error | undefined;
    try { if (databaseLockHeld) await client!.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [id]); } catch (error) {
      unlockError = error instanceof Error ? error : new Error(String(error));
    }
    try { client?.release(unlockError) } catch (error) { unlockError ??= error instanceof Error ? error : new Error(String(error)) }
    release();
    if (this.linkLocks.get(id) === tail) this.linkLocks.delete(id);
    if (unlockError) throw unlockError;
    if (operationFailed) throw operationError;
    return result!;
  }

  private async deleteRemote(id:string, cloudToken:string):Promise<boolean> {
    try { await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'DELETE' }, [404]); return true } catch { return false }
  }

  private async persistRemoteDeleteState(id:string, pending:boolean, queryable:Queryable = this.db):Promise<void> {
    await queryable.query(`UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),keep_available=FALSE,keep_until=NULL,
      reconciliation_required=$2,reconciliation_action=CASE WHEN $2 THEN 'delete' ELSE NULL END,reconciliation_updated_at=CASE WHEN $2 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1`, [id, pending]);
  }

  private async reconcilePendingDeletes(identity:Identity, cloudToken:string):Promise<void> {
    const pending = (await this.db.query(`SELECT id FROM file_share_links WHERE owner_user_id=$1 AND reconciliation_required=TRUE
      AND reconciliation_action='delete' ORDER BY reconciliation_updated_at LIMIT 25`, [identity.user])).rows;
    // Bound reconciliation to one lock/client at a time. This runs during list,
    // so a small pool must retain capacity for unrelated requests.
    for (const { id } of pending) {
      await this.withLinkLock(String(id), async(client) => {
        const current = (await client.query(`SELECT owner_user_id,reconciliation_required,reconciliation_action FROM file_share_links
          WHERE id=$1 AND owner_user_id=$2`, [id, identity.user])).rows[0];
        if (!current?.reconciliation_required || current.reconciliation_action !== 'delete') return;
        if (await this.deleteRemote(String(id), cloudToken)) await this.persistRemoteDeleteState(String(id), false, client);
      });
    }
  }

  private assertCloudPolicy(cloud:any, expected:{ accessMode:string; passwordProtected:boolean; expiresAt:string | null; keepAvailable:boolean; keepUntil:string | null; displaySharerName:boolean; passwordChanged?:boolean }):void {
    const time = (value:unknown) => typeof value === 'string' && value ? new Date(value).toISOString() : null;
    const mismatches:string[] = [];

    if (!cloud || typeof cloud !== 'object') throw Object.assign(new Error('Sulla Cloud returned no share policy'), { status: 502 });
    if (cloud.accessMode !== expected.accessMode) mismatches.push('accessMode');
    if (Boolean(cloud.passwordProtected) !== expected.passwordProtected) mismatches.push('passwordProtected');
    if (expected.passwordChanged && expected.passwordProtected && cloud.passwordUpdated !== true) mismatches.push('passwordUpdated');
    if (time(cloud.expiresAt) !== time(expected.expiresAt)) mismatches.push('expiresAt');
    if (cloud.keepAvailable !== expected.keepAvailable) mismatches.push('keepAvailable');
    if (!Object.hasOwn(cloud, 'keepUntil') || time(cloud.keepUntil) !== time(expected.keepUntil)) mismatches.push('keepUntil');
    if (cloud.displaySharerName !== expected.displaySharerName) mismatches.push('displaySharerName');
    if (mismatches.length) throw Object.assign(new Error(`Sulla Cloud did not confirm share policy fields: ${ mismatches.join(', ') }`), { status: 502 });
  }

  private folderPath(value: unknown): string {
    const normalized = posix.normalize(String(value ?? '').replace(/^\/+/, '')).replace(/\/$/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw Object.assign(new Error('valid folderPath required'), { status: 400 });
    return normalized;
  }

  async create(identity: Identity, input: ShareInput, cloudToken: string) {
    if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required'), { status: 401 });
    const assetKind = input.assetKind === 'capture' ? 'capture' : input.assetKind === 'artifact' ? 'artifact' : 'file';
    const accessMode = input.permission === 'download' || input.accessMode === 'download' ? 'download' : 'view';
    const deviceId = this.config.mode === 'desktop' && input.deviceId ? input.deviceId : this.config.deviceId || identity.device;
    const keepAvailable = input.keepAvailable ?? assetKind === 'capture';
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const keepUntil = input.keepUntil ? new Date(input.keepUntil) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
    if (keepUntil && (!Number.isFinite(keepUntil.getTime()) || keepUntil.getTime() <= Date.now())) throw Object.assign(new Error('keepUntil must be in the future'), { status: 400 });
    if (keepUntil && expiresAt && keepUntil > expiresAt) throw Object.assign(new Error('keepUntil cannot be later than link expiry'), { status: 400 });
    if (input.password !== undefined && (input.password.length < 8 || input.password.length > 256)) throw Object.assign(new Error('password must be 8 to 256 characters'), { status: 400 });
    let targetType: 'file' | 'folder'; let fileId: string | null = null; let collectionId: string; let folderPath: string | null = null; let name: string; let mime: string;
    if (input.fileId) {
      const result = await this.db.query('SELECT id,collection_id,path,mime FROM files WHERE id=$1 AND deleted_at IS NULL', [input.fileId]);
      if (!result.rows[0]) throw Object.assign(new Error('file not found'), { status: 404 });
      ({ id: fileId, collection_id: collectionId, mime } = result.rows[0]); name = basename(result.rows[0].path); targetType = 'file';
    } else {
      if (!input.collectionId) throw Object.assign(new Error('fileId or collectionId + folderPath required'), { status: 400 });
      collectionId = input.collectionId; folderPath = this.folderPath(input.folderPath); name = basename(folderPath); mime = 'application/json'; targetType = 'folder';
      if (keepAvailable) throw Object.assign(new Error('keepAvailable is only supported for files'), { status: 400 });
    }
    const id = randomBytes(12).toString('base64url'); const source = this.config.mode;
    const relaySecret = source === 'server' ? randomBytes(32).toString('base64url') : null;
    return this.withLinkLock(id, async(client) => {
      // The row starts revoked with a durable delete intent. If this process dies
      // after Cloud commits the POST, the next authenticated reconciliation removes it.
      await client.query(`INSERT INTO file_share_links
        (id,owner_user_id,target_type,file_id,collection_id,folder_path,display_name,mime,access_mode,password_protected,password_hash,expires_at,keep_available,keep_until,display_sharer_name,served_from,device_id,relay_secret,asset_kind,capture_metadata,revoked_at,reconciliation_required,reconciliation_action,reconciliation_updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),TRUE,'delete',NOW())`,
      [id, identity.user, targetType, fileId, targetType === 'folder' ? collectionId : null, folderPath, name, mime, accessMode, Boolean(input.password), input.password ? passwordHash(input.password) : null, expiresAt?.toISOString() ?? null, keepAvailable, keepUntil?.toISOString() ?? null, input.displaySharerName ?? true, source, deviceId, relaySecret, assetKind, input.captureMetadata ?? {}]);
      await client.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'created',$2)`, [id, `${ accessMode } access`]);
      try {
        const cloud = await this.cloud(`/shares`, cloudToken, {
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
            relaySecret,
            assetKind,
            captureMetadata: input.captureMetadata ?? {},
          }),
        });
        this.assertCloudPolicy(cloud, {
          accessMode,
          passwordProtected: Boolean(input.password),
          expiresAt:          expiresAt?.toISOString() ?? null,
          keepAvailable,
          keepUntil:          keepUntil?.toISOString() ?? null,
          displaySharerName:  input.displaySharerName ?? true,
        });
        if (keepAvailable) await this.upload(id, cloudToken, client, true);
        await client.query(`UPDATE file_share_links SET public_url=$2,cloud_registered_at=NOW(),served_from=$3,revoked_at=NULL,
          reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1`, [id, cloud.url, keepAvailable ? 'cloud' : source]);
        this.serverRelay?.connect();
        return this.safeRow(identity, id, client);
      } catch (error) {
        const deleted = await this.deleteRemote(id, cloudToken);
        if (deleted) await client.query('DELETE FROM file_share_links WHERE id=$1', [id]);
        else await this.persistRemoteDeleteState(id, true, client);
        throw error;
      }
    });
  }

  async list(identity: Identity, cloudToken?: string) {
    if (cloudToken) {
      try {
        await this.reconcilePendingDeletes(identity, cloudToken);
        const local = (await this.db.query('SELECT * FROM file_share_links WHERE owner_user_id=$1 ORDER BY created_at DESC', [identity.user])).rows;
        const cloud = await this.cloud('/shares', cloudToken); const values = Array.isArray(cloud) ? cloud : cloud.shares ?? cloud.links ?? [];
        const remote = new Map(values.map((item:any) => [String(item.id ?? item.token), remoteShareOverlay(item)]));
        return local.map(item => {
          const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item;
          const overlay:Record<string, unknown> = { ...(remote.get(String(item.id)) ?? {}) };
          if (item.revoked_at || item.reconciliation_required) delete overlay.revoked_at;
          return { ...safe, ...overlay, id: item.id };
        });
      } catch { /* offline list falls through */ }
    }
    const local = (await this.db.query('SELECT * FROM file_share_links WHERE owner_user_id=$1 ORDER BY created_at DESC', [identity.user])).rows;
    return local.map(item => { const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item; return safe });
  }

  private async getRow(identity:Identity, id:string, queryable:Queryable = this.db) {
    const row = (await queryable.query('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2', [id, identity.user])).rows[0];
    if (!row) throw Object.assign(new Error('share not found'), { status: 404 }); return row;
  }

  private async safeRow(identity:Identity, id:string, queryable:Queryable) {
    const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = await this.getRow(identity, id, queryable);
    return safe;
  }

  async get(identity: Identity, id: string) { return this.safeRow(identity, id, this.db) }

  async revoke(identity: Identity, id: string, cloudToken?: string) {
    return this.withLinkLock(id, async(client) => {
      await this.getRow(identity, id, client);
      if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to revoke a public link'), { status: 401 });
      await this.persistRemoteDeleteState(id, true, client);
      const deleted = await this.deleteRemote(id, cloudToken);
      await this.persistRemoteDeleteState(id, !deleted, client);
      await client.query(`INSERT INTO file_share_events(share_id,action) VALUES($1,'revoked')`, [id]);
      if (!deleted) throw Object.assign(new Error('Local access is disabled; remote deletion could not be confirmed and is queued for retry'), { status: 502 });
      return { ok: true };
    });
  }

  async update(identity: Identity, id: string, input:ShareInput, cloudToken: string) {
    return this.withLinkLock(id, async(client) => {
      if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to change link availability'), { status: 401 });
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
      const encodedPassword = input.password === undefined ? row.password_hash : input.password ? passwordHash(input.password) : null;
      // Disable local access and persist cleanup intent before either remote
      // mutation. Cloud requires keepAvailable=true before accepting content.
      await client.query(`UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),reconciliation_required=TRUE,
        reconciliation_action='delete',reconciliation_updated_at=NOW(),updated_at=NOW() WHERE id=$1`, [id]);
      try {
        const cloud = await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'PATCH', body: JSON.stringify({ accessMode: mode, password: input.password, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, keepAvailable: enabled, keepUntil: keepUntil ? new Date(keepUntil).toISOString() : null, displaySharerName: input.displaySharerName ?? row.display_sharer_name }) });
        this.assertCloudPolicy(cloud, {
          accessMode:        mode,
          passwordProtected,
          passwordChanged:  input.password !== undefined,
          expiresAt:         expiresAt ? new Date(expiresAt).toISOString() : null,
          keepAvailable:     enabled,
          keepUntil:         keepUntil ? new Date(keepUntil).toISOString() : null,
          displaySharerName: input.displaySharerName ?? row.display_sharer_name,
        });
        if (enabled && !row.keep_available) await this.upload(id, cloudToken, client, true);
        await client.query(`UPDATE file_share_links SET access_mode=$2,password_protected=$3,password_hash=$4,expires_at=$5,keep_available=$6,keep_until=$7,display_sharer_name=$8,served_from=$9,revoked_at=NULL,reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1`, [id, mode, passwordProtected, encodedPassword, expiresAt ? new Date(expiresAt).toISOString() : null, enabled, keepUntil ? new Date(keepUntil).toISOString() : null, input.displaySharerName ?? row.display_sharer_name, enabled ? 'cloud' : this.config.mode]);
        await client.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'updated',$2)`, [id, `${ mode } access`]);
        return this.safeRow(identity, id, client);
      } catch (error) {
        // A partially-applied policy must never leave the local relay reachable.
        const deleted = await this.deleteRemote(id, cloudToken);
        await this.persistRemoteDeleteState(id, !deleted, client);
        const state = deleted ? 'local access was disabled' : 'local access was disabled and remote deletion is queued because it could not be confirmed';
        throw Object.assign(new Error(`Share settings could not be reconciled; ${ state }: ${ error instanceof Error ? error.message : String(error) }`), { status: 502 });
      }
    });
  }

  async restore(identity:Identity, id:string, cloudToken:string, password?:string) {
    return this.withLinkLock(id, async(client) => {
      if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to restore a public link'), { status: 401 });
      const row = await this.getRow(identity, id, client); if (!row.revoked_at) return this.safeRow(identity, id, client);
      if (row.password_protected && (!password || !row.password_hash || !passwordMatches(password, row.password_hash))) throw Object.assign(new Error('Re-enter the link password to restore this protected share'), { status: 401 });
      if (row.reconciliation_required) {
        if (!await this.deleteRemote(id, cloudToken)) throw Object.assign(new Error('The prior remote link deletion is still pending; restore is blocked until it can be confirmed'), { status: 502 });
      }
      // Keep (or establish) delete intent until the replacement publication is
      // fully verified. A lost POST response is therefore always recoverable.
      await this.persistRemoteDeleteState(id, true, client);
      try {
        const cloud = await this.cloud('/shares', cloudToken, { method: 'POST', body: JSON.stringify({ id, targetType: row.target_type, name: row.display_name, mime: row.mime, accessMode: row.access_mode, password: row.password_protected ? password : undefined, expiresAt: row.expires_at, keepAvailable: false, keepUntil: null, displaySharerName: row.display_sharer_name, servedFrom: this.config.mode, deviceId: row.device_id, relaySecret: row.relay_secret, assetKind: row.asset_kind, captureMetadata: row.capture_metadata }) });
        this.assertCloudPolicy(cloud, {
          accessMode:        row.access_mode,
          passwordProtected: Boolean(row.password_protected),
          expiresAt:         row.expires_at,
          keepAvailable:     false,
          keepUntil:         null,
          displaySharerName: Boolean(row.display_sharer_name),
        });
        await client.query('UPDATE file_share_links SET revoked_at=NULL,public_url=$2,served_from=$3,reconciliation_required=FALSE,reconciliation_action=NULL,reconciliation_updated_at=NULL,updated_at=NOW() WHERE id=$1', [id, cloud.url, this.config.mode]);
        await client.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'created','restored')`, [id]); return this.safeRow(identity, id, client);
      } catch (error) {
        const deleted = await this.deleteRemote(id, cloudToken);
        await this.persistRemoteDeleteState(id, !deleted, client);
        throw error;
      }
    });
  }

  async activity(identity:Identity, id?:string) {
    const params:any[] = [identity.user]; const filter = id ? ' AND l.id=$2' : ''; if (id) params.push(id);
    return (await this.db.query(`SELECT e.id,e.action,e.detail,e.occurred_at FROM file_share_events e JOIN file_share_links l ON l.id=e.share_id WHERE l.owner_user_id=$1${ filter } ORDER BY e.occurred_at DESC LIMIT 500`, params)).rows;
  }

  async authorize(id:string, request:ShareAccessRequest) {
    const row = (await this.db.query('SELECT * FROM file_share_links WHERE id=$1', [id])).rows[0];
    if (!row || row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (row.password_protected && (!request.password || !row.password_hash || !passwordMatches(request.password, row.password_hash))) throw Object.assign(new Error('password required or invalid'), { status: 401 });
    if (request.wantsDownload && row.access_mode !== 'download') throw Object.assign(new Error('download is not allowed'), { status: 403 });
    const action = request.wantsDownload ? 'downloaded' : 'viewed';
    await this.db.query('UPDATE file_share_links SET view_count=view_count+1,last_viewed_at=NOW(),updated_at=NOW() WHERE id=$1', [id]);
    await this.db.query(`INSERT INTO file_share_events(share_id,action) VALUES($1,$2)`, [id, action]);
    return { id: row.id, name: row.display_name, mime: row.mime, mode: row.access_mode, targetType: row.target_type, displaySharerName: row.display_sharer_name };
  }

  async content(id: string, requestedPath = ''): Promise<{ bytes: Buffer; mime: string; name: string }> {
    return this.readContent(id, requestedPath, false, this.db);
  }

  async streamContent(id:string, requestedPath:string, rangeHeader:string | undefined, signal:AbortSignal):Promise<ShareStreamContent> {
    const share = (await this.db.query(`SELECT * FROM file_share_links WHERE id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>NOW())`, [id])).rows[0];
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const listing = await this.readContent(id, requestedPath, false, this.db);
      const range = parseByteRange(rangeHeader, listing.bytes.length);
      const bytes = range ? listing.bytes.subarray(range.start, range.end + 1) : listing.bytes;
      async function * body() { signal.throwIfAborted(); if (bytes.length) yield bytes }
      return { body: body(), mime: listing.mime, name: listing.name, status: range ? 206 : 200, contentLength: bytes.length,
        contentRange: range ? `bytes ${ range.start }-${ range.end }/${ listing.bytes.length }` : undefined };
    }
    let file;
    if (share.target_type === 'file') file = (await this.db.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [share.file_id])).rows[0];
    else {
      const relative = posix.normalize(requestedPath.replace(/^\/+/, ''));
      if (!relative || relative === '..' || relative.startsWith('../')) throw Object.assign(new Error('invalid shared path'), { status: 400 });
      file = (await this.db.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [share.collection_id, `${ share.folder_path }/${ relative }`])).rows[0];
    }
    if (!file) throw Object.assign(new Error('shared file not found'), { status: 404 });
    await assertUnprotectedFile(this.db, file);
    const stream = await streamFileContent(this.db, this.config, this.store, file.id, undefined, rangeHeader, signal);
    if (!stream) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    return { body: stream.body, mime: stream.mime, name: basename(stream.path), status: stream.range ? 206 : 200,
      contentLength: stream.contentLength, contentRange: stream.range ? `bytes ${ stream.range.start }-${ stream.range.end }/${ stream.size }` : undefined };
  }

  private async readContent(id:string, requestedPath:string, allowPendingPublication:boolean, queryable:Queryable):Promise<{ bytes:Buffer; mime:string; name:string }> {
    const share = (await queryable.query(`SELECT * FROM file_share_links WHERE id=$1
      AND (revoked_at IS NULL OR ($2=TRUE AND reconciliation_required=TRUE AND reconciliation_action='delete'))
      AND (expires_at IS NULL OR expires_at>NOW())`, [id, allowPendingPublication])).rows[0];
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const prefix = `${ share.folder_path }/`;
      const escapedPrefix = prefix.replace(/[\\%_]/g, '\\$&');
      const files = (await queryable.query("SELECT path,mime,size FROM files WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=files.id) AND collection_id=$1 AND deleted_at IS NULL AND path LIKE $2 ESCAPE E'\\\\' ORDER BY path", [share.collection_id, `${ escapedPrefix }%`])).rows
        .filter(row => !isProtectedPath(row.path)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
      return { bytes: Buffer.from(JSON.stringify({ name: share.display_name, files })), mime: 'application/json', name: `${ share.display_name }.json` };
    }
    let file;
    if (share.target_type === 'file') file = (await queryable.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [share.file_id])).rows[0];
    else {
      const relative = posix.normalize(requestedPath.replace(/^\/+/, ''));
      if (!relative || relative === '..' || relative.startsWith('../')) throw Object.assign(new Error('invalid shared path'), { status: 400 });
      const full = `${ share.folder_path }/${ relative }`;
      file = (await queryable.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [share.collection_id, full])).rows[0];
    }
    if (!file) throw Object.assign(new Error('shared file not found'), { status: 404 });
    await assertUnprotectedFile(queryable, file);
    const version = (await queryable.query(`SELECT v.chunk_collection_id,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.deleted=FALSE`, [file.current_version_id])).rows[0];
    if (!version) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    const key = (await this.config.keyring!.keys(version.chunk_collection_id, queryable)).data;
    const chunks: Buffer[] = []; for (const chunkId of version.chunk_ids) chunks.push(await decryptChunk(await this.store.get(version.chunk_collection_id, chunkId), key, chunkId));
    return { bytes: Buffer.concat(chunks), mime: file.mime, name: basename(file.path) };
  }

  private async upload(id:string, cloudToken:string, queryable:Queryable, allowPendingPublication = false) {
    const content = await this.readContent(id, '', allowPendingPublication, queryable); await this.cloud(`/shares/${ encodeURIComponent(id) }/content`, cloudToken, {
      method: 'PUT', headers: { 'Content-Type': content.mime, 'X-Sulla-Filename': encodeURIComponent(content.name) }, body: new Uint8Array(content.bytes),
    });
  }

  private async cloud(path: string, token: string, init: RequestInit = {}, acceptedStatuses:number[] = []) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${ token }`); if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${ this.config.cloudUrl }${ path }`, { ...init, headers });
    if (!response.ok && !acceptedStatuses.includes(response.status)) throw Object.assign(new Error(`Sulla Cloud returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`), { status: 502 });
    return response.status === 204 || acceptedStatuses.includes(response.status) ? {} : response.json();
  }
}
