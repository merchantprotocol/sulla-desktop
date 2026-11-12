// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  AuthSession, ClientSessionService, RefreshOutcomeClassifier, RefreshSchedule, TokenPair,
  type CloudAccountTransport, type RefreshLock, type TokenStore,
} from '@sulla/domain';
import { EventDispatcher, SystemClock, type Clock } from '@sulla/foundation';

import { DesktopRefreshLocks, NoListenerResolver } from './DesktopTokenStores';

/** A Sulla Cloud session Desktop stored before the container vault became the authority. */
export interface LegacyCloudSession {
  userId:             string;
  activeContractorId: string;
  /** May be missing in very old rows; only the refresh token is ever sent. */
  accessToken?:       string;
  refreshToken:       string;
}

export type LegacyAdoptionOutcome =
  | { kind: 'rotated'; tokens: { accessToken: string; refreshToken: string } }
  /** Cloud answered 400/401/403: the legacy session is dead and the owner must sign in again. */
  | { kind: 'rejected' };

/** The one legacy session being adopted, held in memory. A server rejection is remembered; nothing is written anywhere. */
class AdoptionTokenStore implements TokenStore {
  private rejectedByServer = false;

  constructor(private session: AuthSession | null) {}

  async read(): Promise<AuthSession | null> {
    return this.session;
  }

  async compareAndSet(expected: AuthSession | null, next: AuthSession): Promise<boolean> {
    if (!expected || !expected.matches(this.session)) return false;
    this.session = next;
    return true;
  }

  async clear(_expected?: AuthSession | null): Promise<boolean> {
    this.rejectedByServer = true;
    return true;
  }

  wasRejected(): boolean {
    return this.rejectedByServer;
  }
}

/**
 * Startup handoff of a legacy session into the container vault: the legacy refresh token is rotated once through the
 * shared domain `ClientSessionService` (single flight under the Desktop refresh lock, domain outcome rules: 400/401/403
 * reject, anything else is transient). A transient failure throws the domain `refresh_transient` IdentityError so the
 * caller retries later with the tokens untouched.
 */
export class LegacyCloudSessionAdopter {
  /** Stands in for a missing legacy access token. Never sent: refresh only sends the refresh token. */
  static readonly NO_ACCESS_TOKEN = 'legacy-session-without-access-token';

  constructor(
    private readonly transport: CloudAccountTransport,
    private readonly lock: RefreshLock = DesktopRefreshLocks.shared,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async refresh(legacy: LegacyCloudSession): Promise<LegacyAdoptionOutcome> {
    const seen = new AuthSession(
      legacy.userId, legacy.activeContractorId,
      new TokenPair(legacy.accessToken || LegacyCloudSessionAdopter.NO_ACCESS_TOKEN, legacy.refreshToken),
    );
    const store = new AdoptionTokenStore(seen);
    const sessions = new ClientSessionService(
      store, this.transport, this.lock, new RefreshSchedule(this.clock),
      new RefreshOutcomeClassifier(), new EventDispatcher(new NoListenerResolver()),
    );
    const next = await sessions.refresh(seen);
    if (store.wasRejected() || !next) return { kind: 'rejected' };
    return { kind: 'rotated', tokens: { accessToken: next.tokens.accessToken, refreshToken: next.tokens.refreshToken } };
  }
}
