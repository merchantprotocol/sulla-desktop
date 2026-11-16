// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FileFingerprints } from './FileFingerprint.js';

import type { FileFingerprint } from './FileFingerprint.js';
import type { FileHandle } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export class PinnedRegularFile {
  constructor(
    readonly relativePath:string,
    readonly fingerprint:FileFingerprint,
    private readonly handle:FileHandle,
  ) {}

  createReadStream(highWaterMark = 4 * 1024 * 1024):Readable {
    return this.handle.createReadStream({ autoClose: false, highWaterMark, start: 0 });
  }

  async assertUnchanged():Promise<void> {
    const current = FileFingerprints.from(await this.handle.stat({ bigint: true }));
    if (!FileFingerprints.sameFingerprint(current, this.fingerprint)) throw new Error('Pinned file changed during operation');
  }

  async close():Promise<void> { await this.handle.close() }
}

export type VerifyPinnedFile = (pinned:PinnedRegularFile)=>Promise<void>;
