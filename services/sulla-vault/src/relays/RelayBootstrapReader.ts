// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { MAX_BOOTSTRAP_BYTES } from './RelayLimits.js';

/** Reads a provider bootstrap JSON body without buffering more than MAX_BOOTSTRAP_BYTES. */
export class RelayBootstrapReader {
  static async readBoundedJson(response: Response): Promise<Record<string, unknown> | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BOOTSTRAP_BYTES) {
        await reader.cancel();
        throw new Error('relay_bootstrap_too_large');
      }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }
}
