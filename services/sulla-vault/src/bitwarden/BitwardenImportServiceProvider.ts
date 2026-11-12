// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { webcrypto } from 'node:crypto';

import {
  BitwardenCipherStringDecryptor,
  BitwardenEncryptedExportReader,
  BitwardenImportService,
  NobleBitwardenCryptoPrimitives,
  WebCryptoRandomSource,
  type BitwardenCryptoPrimitives,
} from '@sulla/domain';

import { BitwardenZipAttachmentReader } from './BitwardenZipAttachmentReader.js';
import { NativeBitwardenCryptoPrimitives } from './NativeBitwardenCryptoPrimitives.js';

/**
 * Lazily composes the domain `BitwardenImportService` for the vault service:
 * native node:crypto primitives (not the domain's pure-JS default) and the
 * Desktop ZIP reader that keeps attachment bytes. Built on first use, then reused.
 */
export class BitwardenImportServiceProvider {
  private service: Promise<BitwardenImportService> | null = null;

  /** Pass primitives (tests) or let the provider build the native ones. */
  constructor(private readonly primitives: () => BitwardenCryptoPrimitives = () => new NativeBitwardenCryptoPrimitives(new NobleBitwardenCryptoPrimitives())) {}

  get(): Promise<BitwardenImportService> {
    this.service ??= Promise.resolve().then(() => {
      const primitives = this.primitives();
      const encrypted = new BitwardenEncryptedExportReader(primitives, new BitwardenCipherStringDecryptor(primitives));
      return new BitwardenImportService(new WebCryptoRandomSource(webcrypto as unknown as Crypto), encrypted, new BitwardenZipAttachmentReader(encrypted));
    });
    this.service.catch(() => { this.service = null; }); // a failed build is retried next time
    return this.service;
  }
}
