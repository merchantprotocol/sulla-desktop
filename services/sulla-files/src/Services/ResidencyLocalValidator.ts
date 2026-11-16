// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import { chunkId } from '../crypto.js';
import { ResidencyVersionGeometry } from './ResidencyVersionGeometry.js';

import type { FilesKeyring } from '../keyring.js';
import type { FileResidencyRepository } from '../Repositories/FileResidencyRepository.js';
import type { FilesMutationCoordinator } from './FilesMutationCoordinator.js';
import type { PinnedRegularFile } from './PinnedRegularFile.js';
import type { LocalValidation, ResidencyVersion } from './ResidencyContracts.js';

/** Proves a local plaintext file is byte-for-byte the current version (chunk ids under the dedup key). */
export class ResidencyLocalValidator {
  constructor(
    private readonly rows:FileResidencyRepository,
    private readonly keyring:FilesKeyring,
    private readonly mutations:FilesMutationCoordinator,
  ) {}

  /** Refuses eviction unless the watcher's last-seen state matches the verified local bytes. */
  async assertLocalVersion(descriptor:ResidencyVersion):Promise<LocalValidation> {
    const watched = await this.rows.findWatchedState(descriptor.collectionId, descriptor.fileId, descriptor.path);
    if (!watched) throw new Error('Online-only refused because the local file has pending or untracked state');
    const local = await this.validatePlainFile(descriptor.path, descriptor);
    if (String(watched.content_hash) !== local.contentHash || Number(watched.size) !== local.size) {
      throw new Error('Online-only refused because the local file has pending edits');
    }
    return local;
  }

  async validatePlainFile(path:string, descriptor:ResidencyVersion):Promise<LocalValidation> {
    const pinned = await this.mutations.pin(path);
    try { return await this.validatePinnedFile(pinned, descriptor) } finally { await pinned.close() }
  }

  async validatePinnedFile(pinned:PinnedRegularFile, descriptor:ResidencyVersion):Promise<LocalValidation> {
    const whole = createHash('sha256');
    let total = 0;
    let index = 0;
    const keys = await this.keyring.copyKeys(descriptor.chunkCollectionId);
    try {
      const stream = pinned.createReadStream(ResidencyVersionGeometry.chunkBytes);
      for await (const value of stream) {
        const plain = Buffer.from(value);
        const expected = descriptor.chunks[index++];
        if (plain.byteLength !== expected?.size || chunkId(plain, keys.dedup) !== expected.id) {
          throw new Error('Local file does not match its current version');
        }
        whole.update(plain);
        total += plain.byteLength;
      }
      if (total === 0) {
        const expected = descriptor.chunks[index++];
        if (expected?.size !== 0 || chunkId(Buffer.alloc(0), keys.dedup) !== expected.id) throw new Error('Empty local file does not match its current version');
      }
      await pinned.assertUnchanged();
      if (index !== descriptor.chunks.length || total !== descriptor.size) {
        throw new Error('Local file changed during residency verification');
      }
      return { contentHash: whole.digest('hex'), size: total, mtimeMs: Math.trunc(pinned.fingerprint.mtimeMs) };
    } finally {
      keys.data.fill(0);
      keys.dedup.fill(0);
    }
  }

  /** A verifier callback for FilesMutationCoordinator that pins the expected version. */
  verifier(descriptor:ResidencyVersion):(pinned:PinnedRegularFile) => Promise<void> {
    return pinned => this.validatePinnedFile(pinned, descriptor).then(() => undefined);
  }
}
