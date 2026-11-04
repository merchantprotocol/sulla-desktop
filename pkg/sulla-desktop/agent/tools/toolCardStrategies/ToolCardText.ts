// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export class ToolCardText {
  string(value: unknown): string { return typeof value === 'string' ? value : ''; }
  truncate(value: string, max = 80): string { return value.length <= max ? value : `${ value.slice(0, max) }…`; }
  countOrList(value: unknown): string {
    if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : `${ value.length } items`;
    return this.string(value);
  }
  extractOutput(result: unknown): string | undefined {
    if (!result) return undefined;
    const value = result as { responseString?: unknown; result?: unknown };
    if (typeof value.responseString === 'string' && value.responseString.trim()) return value.responseString;
    if (typeof value.result === 'string' && value.result.trim()) return value.result;
    if (typeof result === 'string' && result.trim()) return result;
    return undefined;
  }
  shortenHome(value: string): string { return value.replace(/^\/Users\/[^/]+/, '~'); }
}
