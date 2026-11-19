// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SafeDelta } from './privacy';

/**
 * Pre-flight checks that mirror the Cloud validator (sulla-workers
 * src/services/cloud-chat-link/contracts.ts and the deltas route).
 *
 * Cloud rejects a whole batch when one item fails. Running the same rules here
 * lets Desktop drop only the bad item, so the rest of the chat keeps syncing.
 * Dependency-free on purpose: the spec runs under plain Node.
 */
export const MAX_CIPHERTEXT_CHARS = 256 * 1024;
export const MAX_NONCE_CHARS = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,199}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

export interface SkippedDelta { id: string; reason: string }
export interface PreparedDeltas { items: SafeDelta[]; skipped: SkippedDelta[] }

export class DeltaValidator {
  /** Returns the item with a normalised createdAt, or the reason it cannot be sent. */
  check(item: SafeDelta): { ok: true; item: SafeDelta } | { ok: false; reason: string } {
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) return { ok: false, reason: 'invalid_id' };
    if (!Number.isInteger(item.cursor) || item.cursor <= 0) return { ok: false, reason: 'invalid_cursor' };
    if (item.role !== 'user' && item.role !== 'assistant') return { ok: false, reason: 'invalid_role' };

    const createdAt = DeltaValidator.normalizeCreatedAt(item.createdAt);
    if (!createdAt) return { ok: false, reason: 'invalid_created_at' };

    if (item.ciphertext !== undefined) {
      if (!this.isBase64url(item.ciphertext, MAX_CIPHERTEXT_CHARS)) return { ok: false, reason: 'body_too_large_or_invalid' };
      if (!this.isBase64url(item.nonce, MAX_NONCE_CHARS)) return { ok: false, reason: 'invalid_nonce' };
    }
    return { ok: true, item: { ...item, createdAt } };
  }

  /** Splits a batch into sendable items and skipped ones. One bad item never removes its neighbours. */
  prepare(items: SafeDelta[]): PreparedDeltas {
    const result: PreparedDeltas = { items: [], skipped: [] };
    for (const item of items) {
      const verdict = this.check(item);
      if (verdict.ok) result.items.push(verdict.item);
      else result.skipped.push({ id: String(item.id), reason: verdict.reason });
    }
    return result;
  }

  /**
   * ISO 8601 UTC string, or null. Accepts Postgres-style timestamps such as
   * "2026-11-18 17:00:00+00" and naive "2026-11-18 17:00:00" (treated as UTC).
   */
  static normalizeCreatedAt(raw: unknown): string | null {
    // Postgres drivers can hand back timestamptz as a Date despite the string type.
    if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.toISOString() : null;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const direct = Date.parse(raw);
    if (Number.isFinite(direct)) return new Date(direct).toISOString();
    const text = raw.trim().replace(' ', 'T');
    const withZone = /[zZ]|[+-]\d\d(:?\d\d)?$/.test(text) ? text : `${text}Z`;
    const withMinutes = withZone.replace(/([+-]\d\d)$/, '$1:00');
    const parsed = Date.parse(withMinutes);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  private isBase64url(value: unknown, max: number): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && BASE64URL_PATTERN.test(value);
  }
}
