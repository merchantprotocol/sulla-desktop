import { assertUnprotectedFile, isProtectedPath } from './protectedFiles.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { basename, posix } from 'node:path';

import { decryptChunk } from './crypto.js';

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
  expiresAt?:       string;
  keepAvailable?:   boolean;
  keepUntil?:       string;
  displaySharerName?: boolean;
  assetKind?:       'file' | 'capture' | 'artifact';
  captureMetadata?: Record<string, unknown>;
  deviceId?:        string;
}

interface ShareAccessRequest { password?: string; wantsDownload?: boolean }

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

class ServerShareRelay {
  private socket?:    WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;

  constructor(private db: pg.Pool, private config: Config, private content: (id: string, path: string) => Promise<{ bytes: Buffer; mime: string; name: string }>) {}

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
    if (frame.type !== 'share_fetch' || typeof frame.requestId !== 'string' || typeof frame.linkId !== 'string') return;
    const send = (type: string, payload: Record<string, unknown> = {}) => this.socket?.send(JSON.stringify({ type, requestId: frame.requestId, ...payload }));
    try {
      const content = await this.content(frame.linkId, typeof frame.path === 'string' ? frame.path : '');
      send('share_fetch_start', { mime: content.mime, name: content.name });
      for (let offset = 0; offset < content.bytes.length; offset += 64 * 1024) send('share_fetch_chunk', { data: content.bytes.subarray(offset, offset + 64 * 1024).toString('base64') });
      send('share_fetch_end');
    } catch (error) { send('share_fetch_error', { error: error instanceof Error ? error.message : String(error) }) }
  }
}

export class SharesService {
  private serverRelay?: ServerShareRelay;
  constructor(private db: pg.Pool, private config: Config, private store: Store) {
    if (config.mode === 'server') { this.serverRelay = new ServerShareRelay(db, config, (id, path) => this.content(id, path)); this.serverRelay.connect() }
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
    await this.db.query(`INSERT INTO file_share_links
      (id,owner_user_id,target_type,file_id,collection_id,folder_path,display_name,mime,access_mode,password_protected,password_hash,expires_at,keep_available,keep_until,display_sharer_name,served_from,device_id,relay_secret,asset_kind,capture_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, identity.user, targetType, fileId, targetType === 'folder' ? collectionId : null, folderPath, name, mime, accessMode, Boolean(input.password), input.password ? passwordHash(input.password) : null, expiresAt?.toISOString() ?? null, keepAvailable, keepUntil?.toISOString() ?? null, input.displaySharerName ?? true, source, deviceId, relaySecret, assetKind, input.captureMetadata ?? {}]);
    await this.db.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'created',$2)`, [id, `${ accessMode } access`]);
    let cloudCreated = false;
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
      cloudCreated = true;
      this.serverRelay?.connect();
      if (keepAvailable) await this.upload(id, cloudToken);
      await this.db.query('UPDATE file_share_links SET public_url=$2,cloud_registered_at=NOW(),served_from=$3,updated_at=NOW() WHERE id=$1', [id, cloud.url, keepAvailable ? 'cloud' : source]);
      return (await this.get(identity, id));
    } catch (error) {
      if (cloudCreated) await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'DELETE' }).catch(() => {});
      await this.db.query('DELETE FROM file_share_links WHERE id=$1', [id]); throw error;
    }
  }

  async list(identity: Identity, cloudToken?: string) {
    const local = (await this.db.query('SELECT * FROM file_share_links WHERE owner_user_id=$1 ORDER BY created_at DESC', [identity.user])).rows;
    if (cloudToken) {
      try {
        const cloud = await this.cloud('/shares', cloudToken); const values = Array.isArray(cloud) ? cloud : cloud.shares ?? cloud.links ?? [];
        const remote = new Map(values.map((item:any) => [String(item.id ?? item.token), item]));
        return local.map(item => { const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item; return { ...safe, ...(remote.get(String(item.id)) ?? {}), id: item.id, password: undefined } });
      } catch { /* offline list falls through */ }
    }
    return local.map(item => { const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = item; return safe });
  }

  private async getRow(identity:Identity, id:string) {
    const row = (await this.db.query('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2', [id, identity.user])).rows[0];
    if (!row) throw Object.assign(new Error('share not found'), { status: 404 }); return row;
  }

  async get(identity: Identity, id: string) {
    const { password_hash: _passwordHash, relay_secret: _relaySecret, ...safe } = await this.getRow(identity, id);
    return safe;
  }

  async revoke(identity: Identity, id: string, cloudToken?: string) {
    await this.getRow(identity, id);
    if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to revoke a public link'), { status: 401 });
    await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'DELETE' });
    await this.db.query('UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),keep_available=FALSE,keep_until=NULL,updated_at=NOW() WHERE id=$1', [id]);
    await this.db.query(`INSERT INTO file_share_events(share_id,action) VALUES($1,'revoked')`, [id]); return { ok: true };
  }

  async update(identity: Identity, id: string, input:ShareInput, cloudToken: string) {
    if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to change link availability'), { status: 401 });
    const row = await this.getRow(identity, id); if (row.revoked_at) throw Object.assign(new Error('revoked links must be restored before editing'), { status: 409 });
    const mode = input.permission === 'download' || input.accessMode === 'download' ? 'download' : input.accessMode === 'view' || input.permission === 'view' ? 'view' : row.access_mode;
    const enabled = input.keepAvailable ?? row.keep_available; if (row.target_type !== 'file' && enabled) throw Object.assign(new Error('folder copies are not supported'), { status: 400 });
    const expiresAt = input.expiresAt === undefined ? row.expires_at : input.expiresAt ? new Date(input.expiresAt) : null;
    const keepUntil = input.keepUntil === undefined ? row.keep_until : input.keepUntil ? new Date(input.keepUntil) : null;
    if (expiresAt && (!Number.isFinite(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= Date.now())) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
    if (keepUntil && (!Number.isFinite(new Date(keepUntil).getTime()) || new Date(keepUntil).getTime() <= Date.now())) throw Object.assign(new Error('keepUntil must be in the future'), { status: 400 });
    if (keepUntil && expiresAt && new Date(keepUntil) > new Date(expiresAt)) throw Object.assign(new Error('keepUntil cannot be later than link expiry'), { status: 400 });
    if (input.password !== undefined && input.password && (input.password.length < 8 || input.password.length > 256)) throw Object.assign(new Error('password must be 8 to 256 characters'), { status: 400 });
    await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'PATCH', body: JSON.stringify({ accessMode: mode, password: input.password, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, keepAvailable: enabled, keepUntil: keepUntil ? new Date(keepUntil).toISOString() : null, displaySharerName: input.displaySharerName ?? row.display_sharer_name }) });
    if (enabled && !row.keep_available) await this.upload(id, cloudToken);
    const passwordProtected = input.password === undefined ? row.password_protected : Boolean(input.password);
    const encodedPassword = input.password === undefined ? row.password_hash : input.password ? passwordHash(input.password) : null;
    await this.db.query(`UPDATE file_share_links SET access_mode=$2,password_protected=$3,password_hash=$4,expires_at=$5,keep_available=$6,keep_until=$7,display_sharer_name=$8,served_from=$9,updated_at=NOW() WHERE id=$1`, [id, mode, passwordProtected, encodedPassword, expiresAt ? new Date(expiresAt).toISOString() : null, enabled, keepUntil ? new Date(keepUntil).toISOString() : null, input.displaySharerName ?? row.display_sharer_name, enabled ? 'cloud' : this.config.mode]);
    await this.db.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'updated',$2)`, [id, `${ mode } access`]);
    return this.get(identity, id);
  }

  async restore(identity:Identity, id:string, cloudToken:string) {
    if (!cloudToken) throw Object.assign(new Error('Sulla Cloud sign-in required to restore a public link'), { status: 401 });
    const row = await this.getRow(identity, id); if (!row.revoked_at) return this.get(identity, id);
    const cloud = await this.cloud('/shares', cloudToken, { method: 'POST', body: JSON.stringify({ id, targetType: row.target_type, name: row.display_name, mime: row.mime, accessMode: row.access_mode, expiresAt: row.expires_at, keepAvailable: false, displaySharerName: row.display_sharer_name, servedFrom: this.config.mode, deviceId: row.device_id, relaySecret: row.relay_secret, assetKind: row.asset_kind, captureMetadata: row.capture_metadata }) });
    await this.db.query('UPDATE file_share_links SET revoked_at=NULL,public_url=$2,served_from=$3,updated_at=NOW() WHERE id=$1', [id, cloud.url, this.config.mode]);
    await this.db.query(`INSERT INTO file_share_events(share_id,action,detail) VALUES($1,'created','restored')`, [id]); return this.get(identity, id);
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
    const share = (await this.db.query('SELECT * FROM file_share_links WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())', [id])).rows[0];
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const prefix = `${ share.folder_path }/`;
      const escapedPrefix = prefix.replace(/[\\%_]/g, '\\$&');
      const files = (await this.db.query("SELECT path,mime,size FROM files WHERE NOT EXISTS(SELECT 1 FROM files_protected_files p WHERE p.file_id=files.id) AND collection_id=$1 AND deleted_at IS NULL AND path LIKE $2 ESCAPE E'\\\\' ORDER BY path", [share.collection_id, `${ escapedPrefix }%`])).rows
        .filter(row => !isProtectedPath(row.path)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
      return { bytes: Buffer.from(JSON.stringify({ name: share.display_name, files })), mime: 'application/json', name: `${ share.display_name }.json` };
    }
    let file;
    if (share.target_type === 'file') file = (await this.db.query('SELECT * FROM files WHERE id=$1 AND deleted_at IS NULL', [share.file_id])).rows[0];
    else {
      const relative = posix.normalize(requestedPath.replace(/^\/+/, ''));
      if (!relative || relative === '..' || relative.startsWith('../')) throw Object.assign(new Error('invalid shared path'), { status: 400 });
      const full = `${ share.folder_path }/${ relative }`;
      file = (await this.db.query('SELECT * FROM files WHERE collection_id=$1 AND path=$2 AND deleted_at IS NULL', [share.collection_id, full])).rows[0];
    }
    if (!file) throw Object.assign(new Error('shared file not found'), { status: 404 });
    await assertUnprotectedFile(this.db, file);
    const version = (await this.db.query(`SELECT v.chunk_collection_id,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.deleted=FALSE`, [file.current_version_id])).rows[0];
    if (!version) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    const key = (await this.config.keyring!.keys(version.chunk_collection_id)).data;
    const chunks: Buffer[] = []; for (const chunkId of version.chunk_ids) chunks.push(await decryptChunk(await this.store.get(version.chunk_collection_id, chunkId), key, chunkId));
    return { bytes: Buffer.concat(chunks), mime: file.mime, name: basename(file.path) };
  }

  private async upload(id: string, cloudToken: string) {
    const content = await this.content(id); await this.cloud(`/shares/${ encodeURIComponent(id) }/content`, cloudToken, {
      method: 'PUT', headers: { 'Content-Type': content.mime, 'X-Sulla-Filename': encodeURIComponent(content.name) }, body: new Uint8Array(content.bytes),
    });
  }

  private async cloud(path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${ token }`); if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${ this.config.cloudUrl }${ path }`, { ...init, headers });
    if (!response.ok) throw Object.assign(new Error(`Sulla Cloud returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`), { status: 502 });
    return response.status === 204 ? {} : response.json();
  }
}
