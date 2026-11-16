// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';

import type { BrowserFillTarget, LocalVaultState } from '../contracts.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { LocalAuthorityCrypto } from './LocalAuthorityCrypto.js';
import { HUMAN_SESSION_TTL_MS } from './LocalAuthorityLimits.js';
import type { HumanSession } from './LocalAuthorityTypes.js';
import { LocalVaultError } from './LocalVaultError.js';

/**
 * Human vault-page sessions: control-issued grants, CSRF validation, exchange, and the
 * password unlock / lock transitions that rotate the grant.
 * Moved verbatim from LocalVaultAuthority (E9); vault state lives on the host.
 */
export class HumanSessionService {
  constructor(private readonly host: LocalAuthorityHost) {}

  createHumanSession(callerId: string, token: string | undefined, browserTarget?: BrowserFillTarget): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget } {
    this.host.requireControlIdentity(callerId, token);
    if (browserTarget) {
      if (!/^[A-Za-z0-9._:-]{1,160}$/.test(browserTarget.tabId)) throw new LocalVaultError('invalid_operation', 400, 'Browser target is invalid');
      let parsed: URL;
      try { parsed = new URL(browserTarget.origin); } catch { throw new LocalVaultError('invalid_destination', 400, 'Browser origin is invalid') }
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== browserTarget.origin) {
        throw new LocalVaultError('invalid_destination', 400, 'Browser origin is invalid');
      }
    }
    return this.issueHumanSession(browserTarget);
  }

  issueHumanSession(browserTarget?: BrowserFillTarget): { sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget } {
    const sessionId = randomBytes(32).toString('base64url');
    const session = {
      csrf: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + HUMAN_SESSION_TTL_MS,
      phase: this.host.keys ? 'unlocked' as const : 'pre-unlock' as const,
      browserTarget,
    };
    this.host.humanSessions.set(sessionId, session);
    return { sessionId, ...session };
  }

  validateHumanSession(sessionId: string | undefined, csrf?: string): HumanSession {
    const session = sessionId ? this.host.humanSessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) this.host.humanSessions.delete(sessionId);
      throw new LocalVaultError('invalid_human_session', 401, 'Human vault session is invalid or expired');
    }
    if (!csrf || !LocalAuthorityCrypto.constantEqual(csrf, session.csrf)) {
      throw new LocalVaultError('invalid_csrf', 403, 'CSRF token is invalid');
    }
    return session;
  }

  async unlockHumanSession(sessionId: string | undefined, csrf: string | undefined, password: string): Promise<{
    sessionId: string; csrf: string; expiresAt: number; phase: 'unlocked'; state: LocalVaultState; cacheMode: 'helper-update-required';
  }> {
    return this.host.runSecurityOperation(async() => {
    const session = this.host.validateHumanSession(sessionId, csrf);
    if (session.phase !== 'pre-unlock') throw new LocalVaultError('invalid_human_session', 409, 'Vault is already unlocked');
    const result = await this.host.unlockWithPassword(password);
    // activateMasterKey invalidates every pre-unlock grant before installing keys.
    const next = this.issueHumanSession(session.browserTarget);
    if (next.phase !== 'unlocked') throw new LocalVaultError('vault_unavailable', 503, 'Vault unlock did not establish an unlocked session');
    return { ...next, phase: 'unlocked', state: result.state, cacheMode: 'helper-update-required' };
    });
  }

  exchangeHumanGrant(sessionId: string | undefined, csrf: string | undefined): {
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked'; browserTarget?: BrowserFillTarget;
  } {
    const session = this.host.validateHumanSession(sessionId, csrf);
    this.host.humanSessions.delete(sessionId!);
    return this.issueHumanSession(session.browserTarget);
  }

  humanSessionStatus(sessionId: string | undefined, csrf: string | undefined): {
    csrf: string; expiresAt: number; phase: 'pre-unlock' | 'unlocked';
  } {
    const session = this.host.validateHumanSession(sessionId, csrf);
    return { csrf: session.csrf, expiresAt: session.expiresAt, phase: session.phase };
  }

  async lockHumanSession(sessionId: string | undefined, csrf: string | undefined): Promise<{
    sessionId: string; csrf: string; expiresAt: number; phase: 'pre-unlock'; state: 'locked';
  }> {
    return this.host.runSecurityOperation(async() => {
      const session = this.host.validateHumanSession(sessionId, csrf);
      this.host.lockNow();
      const next = this.issueHumanSession(session.browserTarget);
      if (next.phase !== 'pre-unlock') throw new LocalVaultError('vault_unavailable', 503, 'Vault did not lock');
      return { ...next, phase: 'pre-unlock', state: 'locked' };
    });
  }
}
