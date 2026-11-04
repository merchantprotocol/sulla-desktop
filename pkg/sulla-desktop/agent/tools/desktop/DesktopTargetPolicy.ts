// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Privacy policy for desktop automation targets. */
export class DesktopTargetPolicy {
  private readonly blockedTargets = ['keychain access', '1password', 'bitwarden', 'localhost:4777'];

  isBlocked(value: unknown): boolean {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    return this.blockedTargets.some(blocked => text.includes(blocked));
  }
}
