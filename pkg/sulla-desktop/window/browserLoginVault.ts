// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface BrowserLoginVaultLogger { log(...args: unknown[]): void }

/**
 * Decides whether the in-page password manager (match dropdown, save/update
 * toast, one-click fill) can run in browser tabs.
 *
 * It needs each saved login's website URL, username and password in the main
 * process. Under the container vault authority those fields never leave the
 * vault (only routing metadata does), so every lookup was refused with
 * `unsupported_secret_egress` and logged per page load. In that mode the
 * feature is off; saved logins are used from the isolated vault window.
 */
export class BrowserLoginVault {
  private reported = false;

  constructor(
    private readonly usesContainerVaultAuthority: () => boolean,
    private readonly logger: BrowserLoginVaultLogger,
  ) {}

  available(): boolean {
    if (!this.usesContainerVaultAuthority()) return true;
    if (!this.reported) {
      this.reported = true;
      this.logger.log('[BrowserTabView] In-page password save and autofill are off: saved website logins stay inside the vault and are used from the vault window.');
    }
    return false;
  }
}
