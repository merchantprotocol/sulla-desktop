// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type SigningKey = string | Buffer;

/**
 * The capability signing keys Files accepts for data it signed or derived earlier.
 *
 * Desktop derives the Files capability signing key as HMAC-SHA256(secret, CONTEXT) in hex.
 * Before PR #2369 it HMACed the compose-escaped secret (every `$` doubled), so an install
 * whose service secret holds `$` signed backup manifests and derived legacy content keys
 * with that older key. Files receives the raw secret as SULLA_FILES_LOCAL_TOKEN (compose
 * unescapes `$$`), so it can rebuild the previous key, but only when the current key is
 * exactly the Desktop derivation of that token; any other configuration has one key.
 *
 * New data is always signed with `current`. Never log either key.
 */
export class CapabilityKeyCandidates {
  private static readonly DESKTOP_CONTEXT = 'sulla-files-capability-v1';

  constructor(readonly current:SigningKey, private readonly previous?:SigningKey) {}

  static fromConfig(config:{ capabilitySigningKey:SigningKey; localToken?:string }):CapabilityKeyCandidates {
    const current = config.capabilitySigningKey;
    const secret = config.localToken;
    if (typeof current !== 'string' || !secret || !secret.includes('$')) return new CapabilityKeyCandidates(current);
    if (!CapabilityKeyCandidates.same(current, CapabilityKeyCandidates.desktopKey(secret))) return new CapabilityKeyCandidates(current);
    return new CapabilityKeyCandidates(current, CapabilityKeyCandidates.desktopKey(secret.replace(/\$/g, '$$$$')));
  }

  /** A bare key (older callers) becomes a single-candidate set. */
  static of(keys:SigningKey | CapabilityKeyCandidates):CapabilityKeyCandidates {
    return keys instanceof CapabilityKeyCandidates ? keys : new CapabilityKeyCandidates(keys);
  }

  /** Current key first, then the pre-#2369 key when one applies. */
  get all():readonly SigningKey[] {
    return this.previous === undefined ? [this.current] : [this.current, this.previous];
  }

  get hasPrevious():boolean { return this.previous !== undefined }

  private static desktopKey(secret:string):string {
    return createHmac('sha256', secret).update(CapabilityKeyCandidates.DESKTOP_CONTEXT).digest('hex');
  }

  private static same(left:string, right:string):boolean {
    const a = Buffer.from(left); const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
