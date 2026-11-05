// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CryptoError } from '@sulla/domain';

import { EnvelopeError } from './VaultSyncContracts.js';

/** Preserves Desktop's observable error contract at the shared-domain boundary. */
export class DomainEnvelopeErrorMapper {
  private static readonly MESSAGES: Readonly<Record<string, string>> = Object.freeze({
    bundle_mac: 'Vault bundle failed its integrity check',
    record_moved: 'Record belongs to another vault or scope',
    record_mac: 'Record failed its integrity check',
    head_mac: 'Manifest head failed its integrity check',
    rollback: 'Sulla Cloud served an older copy than this browser has seen',
    head_chain: 'Manifest head does not extend the previously verified head',
    state_mismatch: 'Records do not match the signed manifest',
    duplicate_record: 'Two records share one id',
    decrypt_failed: 'Decryption failed',
    wrong_password: 'Wrong master password',
    non_integer: 'Canonical JSON only carries safe integers',
    bad_type: 'Canonical JSON cannot carry this value',
  });

  map(error: unknown, macFailureCode?: string): EnvelopeError | unknown {
    if (error instanceof CryptoError) return new EnvelopeError(error.code, DomainEnvelopeErrorMapper.MESSAGES[error.code]);
    if (macFailureCode && error instanceof TypeError) {
      return new EnvelopeError(macFailureCode, DomainEnvelopeErrorMapper.MESSAGES[macFailureCode]);
    }
    return error;
  }
}
