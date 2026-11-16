// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Web permissions for the human-only vault view. Everything is denied except
 * writing to the clipboard from the vault's own origin, which the vault's
 * Copy buttons (item fields, recovery key) need. Without it Chromium rejects
 * navigator.clipboard.writeText and every Copy button fails.
 */
export class VaultPermissionPolicy {
  private static readonly ALLOWED = new Set(['clipboard-sanitized-write']);

  constructor(private readonly vaultOrigin: string) {}

  allows(permission: string, requestingUrl: string | undefined): boolean {
    if (!VaultPermissionPolicy.ALLOWED.has(permission) || !requestingUrl) return false;
    try {
      return new URL(requestingUrl).origin === this.vaultOrigin;
    } catch {
      return false;
    }
  }
}
