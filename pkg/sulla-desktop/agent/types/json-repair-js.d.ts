// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

declare module 'json-repair-js' {
  export function repairJson(json: string, options?: {
    returnObjects?: boolean;
    skipJsonParse?: boolean;
    logging?:       boolean;
    ensureAscii?:   boolean;
  }): string | object;

  export function loads(text: string): unknown;
}
