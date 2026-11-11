// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { KeyWrap, NobleCryptoPrimitives } from '@sulla/domain';
import { loadSodium } from './envelope.js';
import { SodiumCryptoPrimitives } from './SodiumCryptoPrimitives.js';
import { StoredKeyEnvelopeReader } from './StoredKeyEnvelopeReader.js';

/** Lazily constructs the domain KeyWrap-backed reader for the vault-service composition. */
export class StoredKeyEnvelopeReaderProvider {
  private reader: Promise<StoredKeyEnvelopeReader> | null = null;

  /** Pass a ready reader (tests) or let the provider build one on the libsodium primitives. */
  constructor(reader?: StoredKeyEnvelopeReader) {
    if (reader) this.reader = Promise.resolve(reader);
  }

  get(): Promise<StoredKeyEnvelopeReader> {
    this.reader ??= loadSodium().then(sodium => {
      const crypto = new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives());
      return new StoredKeyEnvelopeReader(new KeyWrap(crypto, crypto));
    });
    return this.reader;
  }
}
