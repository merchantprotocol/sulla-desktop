// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Serializes complete recorded trace payloads without modification. */
export class TracePayloadSerializer {
  serialize(value: unknown): string {
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
    return text;
  }

  summary(value: unknown): string {
    return this.serialize(value).replace(/\s+/g, ' ').trim();
  }
}
