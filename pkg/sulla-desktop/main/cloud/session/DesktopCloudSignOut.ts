// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { SignOutResult } from '@sulla/domain';

/** The app-local pieces of a Desktop Cloud sign-out. No tokens pass through here. */
export interface DesktopSignOutPorts {
  /** True when the container vault is the credential authority (the default); false in server mode. */
  usesContainerVault(): boolean;
  clearPendingMasterKey(): void;
  clearPendingCredential(): Promise<void>;
  /** Container-vault clear (the vault broker). Throws when the broker could not clear the session. */
  clearContainerSession(): Promise<void>;
}

/** The server-mode session holder (LegacyCloudSessionRefresher). */
export interface ServerModeSessions {
  invalidate(): void;
  signOut(): Promise<SignOutResult>;
}

export type DesktopSignOutOutcome =
  /** `serverRevoked` is null under the container vault: the vault service owns that session, not Desktop. */
  | { signedOut: true; serverRevoked: boolean | null }
  | { signedOut: false; error: unknown };

/**
 * Chooses the sign-out path for `sulla-cloud:logout`.
 * - Container vault: exactly the previous behaviour (invalidate, drop the pending key and credential, broker clear).
 * - Server mode: the domain SignOutService via the session holder: clear locally first, then revoke on Sulla Cloud.
 * A failed local clear returns `signedOut: false` so the caller keeps Desktop paired and consistent.
 */
export class DesktopCloudSignOut {
  constructor(private readonly ports: DesktopSignOutPorts, private readonly sessions: ServerModeSessions) {}

  async run(): Promise<DesktopSignOutOutcome> {
    if (this.ports.usesContainerVault()) return this.containerVault();
    this.ports.clearPendingMasterKey();
    try {
      const result = await this.sessions.signOut();
      return { signedOut: true, serverRevoked: result.remoteRevoked };
    } catch (error) {
      return { signedOut: false, error };
    }
  }

  private async containerVault(): Promise<DesktopSignOutOutcome> {
    this.sessions.invalidate();
    this.ports.clearPendingMasterKey();
    await this.ports.clearPendingCredential();
    try {
      await this.ports.clearContainerSession();
    } catch (error) {
      return { signedOut: false, error };
    }
    return { signedOut: true, serverRevoked: null };
  }
}
