import { createHmac, randomBytes } from 'node:crypto';
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
  assetKind?:       'file' | 'capture' | 'artifact';
  captureMetadata?: Record<string, unknown>;
}

export class SharesService {
  constructor(private db: pg.Pool, private config: Config, private store: Store) {}

  private async canView(identity: Identity, collectionId: string): Promise<void> {
    const result = await this.db.query("SELECT role FROM collection_acl WHERE collection_id=$1 AND principal_type='user' AND principal_id=$2", [collectionId, identity.user]);
    if (!result.rows[0]) throw Object.assign(new Error('access denied'), { status: 403 });
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
    const keepAvailable = input.keepAvailable ?? assetKind === 'capture';
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw Object.assign(new Error('expiry must be in the future'), { status: 400 });
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
    await this.canView(identity, collectionId);
    const id = randomBytes(12).toString('base64url'); const source = this.config.mode;
    await this.db.query(`INSERT INTO file_share_links
      (id,owner_user_id,target_type,file_id,collection_id,folder_path,display_name,mime,access_mode,password_protected,expires_at,keep_available,served_from,device_id,asset_kind,capture_metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, identity.user, targetType, fileId, targetType === 'folder' ? collectionId : null, folderPath, name, mime, accessMode, Boolean(input.password), expiresAt?.toISOString() ?? null, keepAvailable, source, this.config.deviceId || identity.device, assetKind, input.captureMetadata ?? {}]);
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
          servedFrom:      source,
          deviceId:        this.config.deviceId || identity.device,
          assetKind,
          captureMetadata: input.captureMetadata ?? {},
        }),
      });
      cloudCreated = true;
      if (keepAvailable) await this.upload(id, cloudToken);
      await this.db.query('UPDATE file_share_links SET public_url=$2,cloud_registered_at=NOW(),served_from=$3,updated_at=NOW() WHERE id=$1', [id, cloud.url, keepAvailable ? 'cloud' : source]);
      return (await this.get(identity, id));
    } catch (error) {
      if (cloudCreated) await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'DELETE' }).catch(() => {});
      await this.db.query('DELETE FROM file_share_links WHERE id=$1', [id]); throw error;
    }
  }

  async list(identity: Identity, cloudToken?: string) {
    if (cloudToken) {
      try { return await this.cloud('/shares', cloudToken) } catch { /* offline list falls through */ }
    }
    return (await this.db.query('SELECT * FROM file_share_links WHERE owner_user_id=$1 ORDER BY created_at DESC', [identity.user])).rows;
  }

  async get(identity: Identity, id: string) {
    const row = (await this.db.query('SELECT * FROM file_share_links WHERE id=$1 AND owner_user_id=$2', [id, identity.user])).rows[0];
    if (!row) throw Object.assign(new Error('share not found'), { status: 404 }); return row;
  }

  async revoke(identity: Identity, id: string, cloudToken?: string) {
    await this.get(identity, id); if (cloudToken) await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'DELETE' });
    await this.db.query('UPDATE file_share_links SET revoked_at=COALESCE(revoked_at,NOW()),updated_at=NOW() WHERE id=$1', [id]); return { ok: true };
  }

  async setKeepAvailable(identity: Identity, id: string, enabled: boolean, cloudToken: string) {
    const row = await this.get(identity, id); if (row.target_type !== 'file' && enabled) throw Object.assign(new Error('folder copies are not supported'), { status: 400 });
    await this.cloud(`/shares/${ encodeURIComponent(id) }`, cloudToken, { method: 'PATCH', body: JSON.stringify({ keepAvailable: enabled }) });
    if (enabled) await this.upload(id, cloudToken);
    await this.db.query('UPDATE file_share_links SET keep_available=$2,served_from=$3,updated_at=NOW() WHERE id=$1', [id, enabled, enabled ? 'cloud' : this.config.mode]);
    return this.get(identity, id);
  }

  async content(id: string, requestedPath = ''): Promise<{ bytes: Buffer; mime: string; name: string }> {
    const share = (await this.db.query('SELECT * FROM file_share_links WHERE id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW())', [id])).rows[0];
    if (!share) throw Object.assign(new Error('share not found or inactive'), { status: 404 });
    if (share.target_type === 'folder' && !requestedPath) {
      const prefix = `${ share.folder_path }/`;
      const escapedPrefix = prefix.replace(/[\\%_]/g, '\\$&');
      const files = (await this.db.query("SELECT path,mime,size FROM files WHERE collection_id=$1 AND deleted_at IS NULL AND path LIKE $2 ESCAPE E'\\\\' ORDER BY path", [share.collection_id, `${ escapedPrefix }%`])).rows
        .map(row => ({ ...row, path: row.path.slice(prefix.length) }));
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
    const version = (await this.db.query(`SELECT v.chunk_collection_id,m.chunk_ids FROM file_versions v JOIN manifests m ON m.hash=v.manifest_hash WHERE v.id=$1 AND v.deleted=FALSE`, [file.current_version_id])).rows[0];
    if (!version) throw Object.assign(new Error('shared file has no readable version'), { status: 404 });
    const key = createHmac('sha256', this.config.capabilitySigningKey).update(`sulla:files:data-key:v1:${ version.chunk_collection_id }`).digest();
    const chunks: Buffer[] = []; for (const chunkId of version.chunk_ids) chunks.push(await decryptChunk(await this.store.get(version.chunk_collection_id, chunkId), key, chunkId));
    return { bytes: Buffer.concat(chunks), mime: file.mime, name: basename(file.path) };
  }

  private async upload(id: string, cloudToken: string) {
    const content = await this.content(id); await this.cloud(`/shares/${ encodeURIComponent(id) }/content`, cloudToken, {
      method: 'PUT', headers: { 'Content-Type': content.mime, 'X-Sulla-Filename': encodeURIComponent(content.name) }, body: content.bytes,
    });
  }

  private async cloud(path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Authorization', `Bearer ${ token }`); if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${ this.config.cloudUrl }${ path }`, { ...init, headers });
    if (!response.ok) throw Object.assign(new Error(`Sulla Cloud returned ${ response.status }: ${ (await response.text()).slice(0, 200) }`), { status: 502 });
    return response.status === 204 ? {} : response.json();
  }
}
