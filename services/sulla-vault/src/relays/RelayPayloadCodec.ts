// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { SENSITIVE_KEY } from './RelayLimits.js';

/** Byte sizing and credential redaction for relay payloads before they leave the vault. */
export class RelayPayloadCodec {
  static jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value));
  }

  static redactText(value: string, sensitiveValues: Iterable<string>): string {
    let output = value;
    for (const sensitiveValue of sensitiveValues) {
      if (sensitiveValue.length >= 4) output = output.split(sensitiveValue).join('[redacted]');
    }
    return output;
  }

  static sanitized(value: unknown, sensitiveValues: Iterable<string> = [], depth = 0): unknown {
    if (depth > 12) return '[depth-limited]';
    if (typeof value === 'string') return RelayPayloadCodec.redactText(value, sensitiveValues);
    if (Array.isArray(value)) return value.slice(0, 2_000).map(entry => RelayPayloadCodec.sanitized(entry, sensitiveValues, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) continue;
      output[key] = RelayPayloadCodec.sanitized(entry, sensitiveValues, depth + 1);
    }
    return output;
  }
}
