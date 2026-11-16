// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type sodiumModule from 'libsodium-wrappers-sumo';

import type { Base64 } from './types.js';

export type SodiumApi = typeof sodiumModule;

/**
 * Owns the libsodium instance. Nothing touches sodium before `ready()` resolves, so importing the
 * package never waits on WebAssembly start-up. Base64 is always URL-safe without padding.
 */
export class SodiumRuntime {
  constructor(private readonly sodium: SodiumApi) {}

  /** Resolves once libsodium has initialised and returns the usable API. */
  async ready(): Promise<SodiumApi> {
    await this.sodium.ready;
    return this.sodium;
  }

  /** Call only after `ready()` has resolved. */
  encode(bytes: Uint8Array): Base64 {
    return this.sodium.to_base64(bytes, this.sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  /** Call only after `ready()` has resolved. */
  decode(value: Base64): Uint8Array {
    return this.sodium.from_base64(value, this.sodium.base64_variants.URLSAFE_NO_PADDING);
  }
}
