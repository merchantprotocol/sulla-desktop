// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from 'node:crypto';

/** Canonical byte-preserving row digest for migration verification. */
export class LegacyProfileHashRepository {
  digest(rows: readonly Record<string, unknown>[]): string {
    const canonical = rows.map(row => this.canonical(row)).sort((a, b) => {
      const left = JSON.parse(a) as Record<string, unknown>;
      const right = JSON.parse(b) as Record<string, unknown>;
      const leftPk = left.id ?? left.profile_id ?? left.owner_user_id ?? a;
      const rightPk = right.id ?? right.profile_id ?? right.owner_user_id ?? b;
      return String(leftPk).localeCompare(String(rightPk)) || a.localeCompare(b);
    });
    return createHash('sha256').update(`[${canonical.join(',')}]`, 'utf8').digest('hex');
  }
  private canonical(value: unknown): string {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return JSON.stringify({ $bytea: Buffer.from(value).toString('hex') });
    if (Array.isArray(value)) return `[${value.map(item => this.canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`).join(',')}}`;
    return JSON.stringify(value) ?? 'null';
  }
}
