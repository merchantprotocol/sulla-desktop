import { createHash } from 'node:crypto';

import { issueCapabilityToken } from './auth.js';

import type {
  AuthenticatedResidencyTransport,
  FileResidencyManager,
  RemoteChunkDescriptor,
  RemoteVersionDescriptor,
  RemoteVersionReceipt,
} from './residency.js';
import type express from 'express';
import type pg from 'pg';

const MAX_JSON_BYTES = 1024 * 1024;

export interface ResidencySyncBundle {
  collectionId:        string;
  collection:          Record<string, unknown>;
  file:                Record<string, unknown>;
  version:             Record<string, unknown>;
  manifest:            Record<string, unknown>;
  chunks:              Record<string, unknown>[];
  baseServerVersionId: string | null;
  keyContext:          RemoteVersionDescriptor['keyContext'];
}

export interface HttpResidencyTransportConfig {
  serverUrl:            string;
  userId:               string;
  deviceId:             string;
  capabilitySigningKey: string | Buffer;
  bundleFor(version: RemoteVersionDescriptor): Promise<ResidencySyncBundle>;
}

/** Authenticated transport over the existing Files capability-JWT sync API. */
export class HttpResidencyTransport implements AuthenticatedResidencyTransport {
  readonly authenticated = true as const;
  private readonly baseUrl: URL;
  private readonly alreadyCommitted = new Set<string>();

  constructor(private readonly config: HttpResidencyTransportConfig) {
    this.baseUrl = new URL(config.serverUrl);
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== 'https:' && !(loopback && this.baseUrl.protocol === 'http:')) {
      throw new Error('Residency transport requires HTTPS except for loopback');
    }
    if (!config.userId || !config.deviceId || byteLength(config.capabilitySigningKey) < 32) {
      throw new Error('Residency transport requires an authenticated user, device, and signing key');
    }
  }

  async prepareVersion(version: RemoteVersionDescriptor, signal: AbortSignal): Promise<{ missingChunkIds: string[] }> {
    const bundle = await this.bundle(version);
    await this.json('/v1/collections', { method: 'POST', body: JSON.stringify({ collection: bundle.collection }), signal });
    const response = await this.json('/v1/versions/prepare', { method: 'POST', body: JSON.stringify(bundle), signal });
    if (response.conflict && response.currentVersionId === version.versionId) this.alreadyCommitted.add(version.versionId);
    else if (response.conflict) throw new Error('Remote version conflict prevents eviction');
    if (response.canonicalFileId !== version.fileId) throw new Error('Remote canonical file identity does not match');
    return { missingChunkIds: stringArray(response.missing) };
  }

  async uploadChunk(input: {
    versionId:    string;
    collectionId: string;
    chunk:        RemoteChunkDescriptor;
    ciphertext:   Uint8Array;
    signal:       AbortSignal;
  }): Promise<void> {
    if (input.ciphertext.byteLength !== input.chunk.storedSize) throw new Error('Chunk upload size does not match descriptor');
    await this.request(`/v1/chunks/${ encodeURIComponent(input.collectionId) }/${ encodeURIComponent(input.chunk.id) }`, {
      method:  'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(input.ciphertext.byteLength) },
      body:    Buffer.from(input.ciphertext),
      signal:  input.signal,
    });
  }

  async commitVersion(version: RemoteVersionDescriptor, signal: AbortSignal): Promise<void> {
    if (this.alreadyCommitted.delete(version.versionId)) {
      await this.verifyVersion(version, signal);
      return;
    }
    const response = await this.json('/v1/versions/commit', { method: 'POST', body: JSON.stringify(await this.bundle(version)), signal });
    if (response.versionId !== version.versionId || response.fileId !== version.fileId) {
      throw new Error('Remote committed a different immutable version');
    }
  }

  async verifyVersion(version: RemoteVersionDescriptor, signal: AbortSignal): Promise<RemoteVersionReceipt> {
    const remote = await this.json(`/v1/versions/${ encodeURIComponent(version.versionId) }`, { signal });
    if (remote.file?.id !== version.fileId || remote.file?.collection_id !== version.collectionId ||
        remote.version?.id !== version.versionId || remote.version?.file_id !== version.fileId ||
        remote.version?.chunk_collection_id !== version.chunkCollectionId ||
        remote.version?.manifest_hash !== version.manifestHash || Number(remote.version?.size) !== version.size ||
        remote.manifest?.hash !== version.manifestHash || Number(remote.manifest?.total_size) !== version.size ||
        !sameContext(remote.keyContext, version.keyContext) ||
        JSON.stringify(remote.manifest?.chunk_ids) !== JSON.stringify(version.chunks.map(chunk => chunk.id))) {
      throw new Error('Authenticated remote returned different version geometry');
    }
    return {
      ...version,
      remoteRevision: createHash('sha256').update(JSON.stringify(remote)).digest('hex'),
    };
  }

  async downloadChunk(input: {
    versionId:    string;
    collectionId: string;
    chunk:        RemoteChunkDescriptor;
    signal:       AbortSignal;
  }): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.request(
      `/v1/chunks/${ encodeURIComponent(input.collectionId) }/${ encodeURIComponent(input.chunk.id) }`,
      { signal: input.signal },
    );
    if (!response.body) throw new Error('Remote chunk response has no body');
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  private async bundle(version: RemoteVersionDescriptor): Promise<ResidencySyncBundle> {
    const bundle = await this.config.bundleFor(version);
    if (bundle.collectionId !== version.collectionId || bundle.collection.id !== version.collectionId ||
        bundle.file.id !== version.fileId || bundle.version.id !== version.versionId ||
        bundle.manifest.hash !== version.manifestHash || !sameContext(bundle.keyContext, version.keyContext)) {
      throw new Error('Residency sync bundle does not match the requested immutable version');
    }
    return bundle;
  }

  private async json(path: string, init: RequestInit): Promise<any> {
    const response = await this.request(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const bytes = await readBounded(response, MAX_JSON_BYTES);
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Remote returned invalid JSON') }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      redirect: 'error',
      headers:  {
        authorization: `Bearer ${ issueCapabilityToken({
          sub:       this.config.userId,
          device_id: this.config.deviceId,
          scopes:    ['files/*'],
        }, this.config.capabilitySigningKey) }`,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const error = await readBounded(response, MAX_JSON_BYTES).catch(() => Buffer.alloc(0));
      throw new Error(`Residency remote request failed (${ response.status }): ${ error.toString('utf8').slice(0, 500) }`);
    }
    return response;
  }
}

/** Loads the exact existing Files sync bundle; no key material is included. */
export async function loadResidencySyncBundle(db: pg.Pool, expected: RemoteVersionDescriptor): Promise<ResidencySyncBundle> {
  const row = (await db.query(
    `SELECT row_to_json(c.*) AS collection,row_to_json(f.*) AS file,row_to_json(v.*) AS version,row_to_json(m.*) AS manifest
       FROM files f JOIN file_versions v ON v.id=$1 AND v.file_id=f.id
       JOIN collections c ON c.id=f.collection_id
       JOIN manifests m ON m.hash=v.manifest_hash
      WHERE f.id=$2 AND f.collection_id=$3 AND f.current_version_id=v.id AND NOT v.deleted`,
    [expected.versionId, expected.fileId, expected.collectionId],
  )).rows[0];
  if (row?.version.chunk_collection_id !== expected.chunkCollectionId ||
      row.manifest.hash !== expected.manifestHash || Number(row.version.size) !== expected.size) {
    throw new Error('Current database version changed before remote publication');
  }
  const chunks = (await db.query(
    `SELECT id,size,stored_size,location FROM chunks
      WHERE collection_id=$1 AND id=ANY($2::text[])`,
    [expected.chunkCollectionId, expected.chunks.map(chunk => chunk.id)],
  )).rows;
  const byId = new Map(chunks.map(chunk => [String(chunk.id), chunk]));
  const ordered = expected.chunks.map(chunk => {
    const rowChunk = byId.get(chunk.id);
    if (!rowChunk || Number(rowChunk.size) !== chunk.size || Number(rowChunk.stored_size) !== chunk.storedSize) {
      throw new Error('Chunk metadata changed before remote publication');
    }
    return rowChunk;
  });
  return {
    collectionId:        expected.collectionId,
    collection:          row.collection,
    file:                row.file,
    version:             row.version,
    manifest:            row.manifest,
    chunks:              ordered,
    baseServerVersionId: row.version.base_server_version_id ?? row.version.parent_version_id ?? null,
    keyContext:          expected.keyContext,
  };
}

/** Mount after the standard Files authentication and unlocked middleware. */
export function registerResidencyRoutes(app: express.Application, manager: FileResidencyManager, authorize:(request:express.Request, fileId:string)=>Promise<void>): void {
  app.get('/v1/residency-capabilities', (_request, response) => response.json(manager.capabilities()));
  app.get('/v1/files/:id/residency', async(request, response) => {
    try { await authorize(request, request.params.id); response.json({ ...await manager.status(request.params.id), capabilities: manager.capabilities() }) } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }) }
  });
  app.post('/v1/files/:id/residency', async(request, response) => {
    try {
      await authorize(request, request.params.id);
      if (request.body?.desiredState === 'online-only') await manager.makeOnlineOnly(request.params.id);
      else if (request.body?.desiredState === 'local') await manager.keepOnComputer(request.params.id);
      else { response.status(400).json({ error: 'desiredState must be local or online-only' }); return }
      response.json(await manager.status(request.params.id));
    } catch (error) { response.status(errorStatus(error)).json({ error: errorMessage(error) }) }
  });
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
    const part = Buffer.from(value);
    total += part.byteLength;
    if (total > limit) {
      await response.body.cancel().catch(() => undefined);
      throw new Error('Remote response exceeded its authenticated bound');
    }
    parts.push(part);
  }
  return Buffer.concat(parts, total);
}

function byteLength(value: string | Buffer): number { return typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength }
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Remote returned invalid chunk identifiers');
  return value;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Residency operation failed' }
function errorStatus(error: unknown): number { const status = Number((error as { status?:unknown } | null)?.status); return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 409 }
function sameContext(left:unknown, right:RemoteVersionDescriptor['keyContext']):boolean {
  if (!left || typeof left !== 'object') return false;
  const value = left as Record<string, unknown>;
  return value.collectionId === right.collectionId && value.principalId === right.principalId &&
    Number(value.keyVersion) === right.keyVersion && Number(value.epoch) === right.epoch;
}
