// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import type { RemoteChunkDescriptor, RemoteVersionDescriptor, RemoteVersionReceipt, ResidencyVersion } from './ResidencyContracts.js';
import type { FilesKeyBundleContext } from '@sulla/vault-crypto';

/** Pure comparisons and digests over residency version descriptors and remote chunk streams. */
export class ResidencyVersionGeometry {
  static readonly chunkBytes = 4 * 1024 * 1024;

  static async collectBounded(source:AsyncIterable<Uint8Array>, expectedBytes:number, maxBytes:number, signal:AbortSignal):Promise<Buffer> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) throw new Error('Invalid remote chunk bound');
    const parts:Buffer[] = [];
    let total = 0;
    for await (const value of source) {
      signal.throwIfAborted();
      const part = Buffer.from(value);
      total += part.byteLength;
      if (total > expectedBytes || total > maxBytes) throw new Error('Remote chunk exceeded its declared bound');
      parts.push(part);
    }
    if (total !== expectedBytes) throw new Error('Remote chunk did not match its declared size');
    return Buffer.concat(parts, total);
  }

  static sameContext(left:FilesKeyBundleContext, right:FilesKeyBundleContext):boolean {
    return left.collectionId === right.collectionId && left.principalId === right.principalId &&
      left.keyVersion === right.keyVersion && left.epoch === right.epoch;
  }

  static sameReceipt(version:RemoteVersionDescriptor, receipt:RemoteVersionReceipt):boolean {
    return receipt.fileId === version.fileId && receipt.versionId === version.versionId &&
      receipt.collectionId === version.collectionId && receipt.chunkCollectionId === version.chunkCollectionId &&
      receipt.manifestHash === version.manifestHash &&
      receipt.size === version.size && ResidencyVersionGeometry.sameContext(receipt.keyContext, version.keyContext) &&
      JSON.stringify(receipt.chunks) === JSON.stringify(version.chunks);
  }

  /** True when a stored proof's chunk list matches the version's chunk ids, sizes and digest. */
  static matchesProof(chunks:RemoteChunkDescriptor[], digest:unknown, descriptor:ResidencyVersion):boolean {
    return ResidencyVersionGeometry.chunksDigest(chunks) === digest && chunks.length === descriptor.chunks.length &&
      !chunks.some((chunk, index) => chunk.id !== descriptor.chunks[index].id || chunk.size !== descriptor.chunks[index].size || chunk.storedSize !== descriptor.chunks[index].storedSize);
  }

  static remoteVersion(descriptor:ResidencyVersion, chunks:RemoteChunkDescriptor[], keyContext:FilesKeyBundleContext):RemoteVersionDescriptor {
    return {
      fileId:            descriptor.fileId,
      versionId:         descriptor.versionId,
      collectionId:      descriptor.collectionId,
      chunkCollectionId: descriptor.chunkCollectionId,
      manifestHash:      descriptor.manifestHash,
      size:              descriptor.size,
      chunks,
      keyContext,
    };
  }

  static chunksDigest(chunks:Pick<RemoteChunkDescriptor, 'id' | 'size' | 'storedSize' | 'ciphertextSha256'>[]):string {
    return ResidencyVersionGeometry.sha256(Buffer.from(JSON.stringify(chunks)));
  }

  static sha256(value:Uint8Array):string { return createHash('sha256').update(value).digest('hex') }
}
