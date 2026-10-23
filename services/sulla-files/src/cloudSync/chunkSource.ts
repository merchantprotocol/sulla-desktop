import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type pg from 'pg';

import type { CloudChunkSource } from '../chunkCache/types.js';
import type { Envelope } from '../crypto.js';
import { CloudOfflineError, type FilesSyncCloudApi } from './cloudApi.js';
import { CHUNK_PLAIN_BYTES, chunkId, FLAG_DEFLATE_RAW, openChunk } from './envelope.js';
import type { CloudRootKeyStore } from './keyStore.js';

interface MappedChunk {
  cloudChunkId:string;
  cipherSha256:string;
  cipherBytes:number;
  keyVersion:number;
  wrappedRoot:Envelope;
  plainBytes:number | null;
}

function integrityError(message:string):Error {
  return Object.assign(new Error(message), { code: 'FILE_INTEGRITY' });
}

/** Opens a cloud wire object and returns verified plaintext (caller zeroes it). */
export async function openCloudChunk(
  root:Uint8Array,
  collectionId:string,
  keyVersion:number,
  cloudChunkId:string,
  wire:Uint8Array,
  expectedPlainBytes?:number | null,
):Promise<Buffer> {
  const opened = await openChunk(root, collectionId, keyVersion, cloudChunkId, wire);
  const plain = opened.flags & FLAG_DEFLATE_RAW
    ? inflateRawSync(opened.body, { maxOutputLength: CHUNK_PLAIN_BYTES })
    : Buffer.from(opened.body);
  if (typeof expectedPlainBytes === 'number' && plain.length !== expectedPlainBytes) {
    plain.fill(0);
    throw integrityError('Cloud chunk size does not match');
  }
  if (await chunkId(root, collectionId, keyVersion, plain) !== cloudChunkId) {
    plain.fill(0);
    throw integrityError('Cloud chunk identity does not match');
  }
  return plain;
}

/**
 * P4's CloudChunkSource (chunkCache/types.ts). Eviction trusts only rows whose
 * cloud copy was verified, and hydration returns plaintext only after the
 * cloud chunk id and size check out.
 */
export class FilesCloudChunkSource implements CloudChunkSource {
  constructor(
    private readonly db:Pick<pg.Pool, 'query'>,
    private readonly api:Pick<FilesSyncCloudApi, 'getChunk'>,
    private readonly roots:Pick<CloudRootKeyStore, 'unwrap'>,
  ) {}

  async verifiedCopy(collectionId:string, localChunkId:string) {
    const row = (await this.db.query(`SELECT cloud_chunk_id,cipher_sha256,cipher_bytes,verified_at
      FROM files_cloud_chunk_map WHERE collection_id=$1 AND local_chunk_id=$2 AND verified_at IS NOT NULL`, [collectionId, localChunkId])).rows[0];
    if (!row) return null;
    return {
      cloudChunkId: String(row.cloud_chunk_id),
      cipherSha256: String(row.cipher_sha256),
      cipherBytes: Number(row.cipher_bytes),
      verifiedAt: new Date(row.verified_at),
    };
  }

  /** GETs the cloud object and compares byte length and sha256 with the map. Any failure is "not verified". */
  async reverify(collectionId:string, localChunkId:string):Promise<boolean> {
    try {
      const mapped = await this.mapped(collectionId, localChunkId);
      if (!mapped) return false;
      const wire = await this.api.getChunk(collectionId, mapped.cloudChunkId);
      const matches = wire.length === mapped.cipherBytes && createHash('sha256').update(wire).digest('hex') === mapped.cipherSha256;
      if (matches) {
        // Only refresh rows that are still trusted; a cleared row (cloud copy being deleted) stays cleared.
        await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NOW() WHERE collection_id=$1 AND local_chunk_id=$2 AND verified_at IS NOT NULL', [collectionId, localChunkId]);
      } else {
        await this.db.query('UPDATE files_cloud_chunk_map SET verified_at=NULL WHERE collection_id=$1 AND local_chunk_id=$2', [collectionId, localChunkId]);
      }
      return matches;
    } catch {
      return false;
    }
  }

  async fetchPlain(collectionId:string, localChunkId:string):Promise<Buffer> {
    const mapped = await this.mapped(collectionId, localChunkId);
    if (!mapped) throw new CloudOfflineError('No cloud copy of this chunk is recorded');
    let wire:Buffer;
    try {
      wire = await this.api.getChunk(collectionId, mapped.cloudChunkId);
    } catch (error:any) {
      if (error?.code === 'FILE_INTEGRITY') throw error;
      throw new CloudOfflineError('Sulla Cloud is unreachable');
    }
    if (wire.length !== mapped.cipherBytes || createHash('sha256').update(wire).digest('hex') !== mapped.cipherSha256) {
      throw integrityError('Cloud chunk ciphertext does not match the recorded copy');
    }
    const root = await this.roots.unwrap(collectionId, mapped.keyVersion, mapped.wrappedRoot);
    try {
      return await openCloudChunk(root, collectionId, mapped.keyVersion, mapped.cloudChunkId, wire, mapped.plainBytes);
    } finally {
      root.fill(0);
    }
  }

  private async mapped(collectionId:string, localChunkId:string):Promise<MappedChunk | null> {
    const row = (await this.db.query(`SELECT m.cloud_chunk_id,m.cipher_sha256,m.cipher_bytes,s.key_version,s.wrapped_root,c.size
      FROM files_cloud_chunk_map m
      JOIN files_cloud_sync s ON s.collection_id=m.collection_id
      LEFT JOIN chunks c ON c.collection_id=m.collection_id AND c.id=m.local_chunk_id
      WHERE m.collection_id=$1 AND m.local_chunk_id=$2 AND s.wrapped_root IS NOT NULL`, [collectionId, localChunkId])).rows[0];
    if (!row) return null;
    return {
      cloudChunkId: String(row.cloud_chunk_id),
      cipherSha256: String(row.cipher_sha256),
      cipherBytes: Number(row.cipher_bytes),
      keyVersion: Number(row.key_version),
      wrappedRoot: row.wrapped_root,
      plainBytes: row.size === null || row.size === undefined ? null : Number(row.size),
    };
  }
}
