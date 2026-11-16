// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type pg from 'pg';

import type { CloudChunkSource } from '../chunkCache/types.js';
import { PgCloudChunkMapRepository } from '../Repositories/CloudChunkMapRepository.js';
import { CloudBusyError, CloudOfflineError, type FilesSyncCloudApi } from './cloudApi.js';
import { CHUNK_PLAIN_BYTES, chunkId, FLAG_DEFLATE_RAW, openChunk } from './envelope.js';
import type { CloudRootKeyStore } from './keyStore.js';

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
    db:Pick<pg.Pool, 'query'>,
    private readonly api:Pick<FilesSyncCloudApi, 'getChunk'>,
    private readonly roots:Pick<CloudRootKeyStore, 'unwrap'>,
    private readonly copies:Pick<PgCloudChunkMapRepository, 'verifiedCopy' | 'refreshVerified' | 'clearVerified' | 'mappedCopy'> = new PgCloudChunkMapRepository(db),
  ) {}

  verifiedCopy(collectionId:string, localChunkId:string) {
    return this.copies.verifiedCopy(collectionId, localChunkId);
  }

  /** GETs the cloud object and compares byte length and sha256 with the map. Any failure is "not verified". */
  async reverify(collectionId:string, localChunkId:string):Promise<boolean> {
    try {
      const mapped = await this.copies.mappedCopy(collectionId, localChunkId);
      if (!mapped) return false;
      const wire = await this.api.getChunk(collectionId, mapped.cloudChunkId);
      const matches = wire.length === mapped.cipherBytes && createHash('sha256').update(wire).digest('hex') === mapped.cipherSha256;
      if (matches) {
        // Only refresh rows that are still trusted; a cleared row (cloud copy being deleted) stays cleared.
        await this.copies.refreshVerified(collectionId, localChunkId);
      } else {
        await this.copies.clearVerified(collectionId, localChunkId);
      }
      return matches;
    } catch {
      return false;
    }
  }

  async fetchPlain(collectionId:string, localChunkId:string):Promise<Buffer> {
    const mapped = await this.copies.mappedCopy(collectionId, localChunkId);
    if (!mapped) throw new CloudOfflineError('No cloud copy of this chunk is recorded');
    let wire:Buffer;
    try {
      wire = await this.api.getChunk(collectionId, mapped.cloudChunkId);
    } catch (error:any) {
      if (error?.code === 'FILE_INTEGRITY') throw error;
      if (error instanceof CloudBusyError) throw error;
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
}
