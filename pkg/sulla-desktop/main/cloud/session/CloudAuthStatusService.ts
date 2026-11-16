// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { CloudContractor } from '../account/ElectronCloudAccountTransport';
import type { SessionIdentity } from './CloudSessionRepository';

export interface AuthStatus {
  signedIn:           boolean;
  userId:             string;
  activeContractorId: string;
  phone:              string;
  name:               string;
  contractorCount:    number;
  lastError?:         string;
}

export interface AuthResult {
  ok:                  boolean;
  error?:              string;
  status:              AuthStatus;
  needsVaultMigration?: boolean;
}

/** Reads the non-secret identity of the signed-in session. */
export interface CloudSessionIdentitySource {
  loadIdentity(): Promise<SessionIdentity | null>;
}

/** The startup restore error the status falls back to. */
export interface CloudStartupErrorSource {
  lastError(): string | undefined;
}

/** A broker error as the vault reports it: a machine `code` and/or HTTP `status`. */
export type VaultErrorClassifier = (error: unknown) => { code?: string; status?: number } | undefined;

/**
 * Builds the `sulla-cloud:get-status` payload and answers the identity
 * questions other subsystems ask (signed in? which user? which business?).
 */
export class CloudAuthStatusService {
  constructor(
    private readonly sessions: CloudSessionIdentitySource,
    private readonly startup: CloudStartupErrorSource,
    private readonly vaultError: VaultErrorClassifier,
  ) {}

  static signedOut(lastError?: string): AuthStatus {
    return { signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError };
  }

  static findActiveContractor(session: SessionIdentity): CloudContractor | null {
    return session.contractors.find(c => c.id === session.activeContractorId)
      ?? session.contractors[0]
      ?? null;
  }

  async build(lastError?: string): Promise<AuthStatus> {
    let session: SessionIdentity | null = null;
    try {
      session = await this.sessions.loadIdentity();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...CloudAuthStatusService.signedOut(lastError ?? this.startup.lastError() ?? message), ...( /lock/i.test(message) ? { vaultLocked: true } : { vaultMissing: true }) } as AuthStatus;
    }
    if (!session) {
      return { signedIn: false, userId: '', activeContractorId: '', phone: '', name: '', contractorCount: 0, lastError: lastError ?? this.startup.lastError() };
    }
    const active = CloudAuthStatusService.findActiveContractor(session);
    return {
      signedIn:           true,
      userId:             session.userId,
      activeContractorId: session.activeContractorId,
      phone:              active?.phone ?? '',
      name:               active?.name ?? '',
      contractorCount:    session.contractors.length,
      lastError,
    };
  }

  /** `build()` that never throws: a failure becomes the signed-out status with the same error. */
  buildOrSignedOut(lastError?: string): Promise<AuthStatus> {
    return this.build(lastError).catch(() => CloudAuthStatusService.signedOut(lastError));
  }

  async isSignedIn(): Promise<boolean> {
    return (await this.sessions.loadIdentity()) !== null;
  }

  async activeContractorId(): Promise<string> {
    const session = await this.sessions.loadIdentity();
    return session?.activeContractorId ?? '';
  }

  async currentUserId(): Promise<string> {
    const session = await this.sessions.loadIdentity();
    return session?.userId ?? '';
  }

  /** The message the sign-in and sign-out screens show when the vault could not save or clear the session. */
  vaultSessionError(error: unknown, action: 'sign in' | 'sign out'): string {
    const vault = this.vaultError(error);
    if (vault) {
      if (vault.code === 'vault_locked' || vault.status === 423) return `Your signed-in session could not be restored. Sign in to Sulla Cloud again to ${ action }.`;
      if (vault.status === 404 || vault.code === 'not_found') {
        return `Update the Sulla Vault service to ${ action } from Desktop.`;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Could not ${ action }: ${ message || 'the vault is unavailable' }`;
  }
}
