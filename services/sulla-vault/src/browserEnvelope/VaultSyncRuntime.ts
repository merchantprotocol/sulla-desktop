// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  CallbackRandomSource,
  CanonicalJson,
  KeyWrap,
  NobleCryptoPrimitives,
  VaultSyncCodec,
  type RandomSource,
} from '@sulla/domain';

/** The vault container's single composition point for shared sync-domain services. */
export class VaultSyncRuntime {
  readonly canonical: CanonicalJson;
  readonly codec: VaultSyncCodec;
  readonly random: RandomSource;

  constructor(randomBytes: (length: number) => Uint8Array) {
    const crypto = new NobleCryptoPrimitives();
    this.random = new CallbackRandomSource(randomBytes);
    this.canonical = new CanonicalJson();
    this.codec = new VaultSyncCodec(crypto, new KeyWrap(crypto, this.random));
  }
}
