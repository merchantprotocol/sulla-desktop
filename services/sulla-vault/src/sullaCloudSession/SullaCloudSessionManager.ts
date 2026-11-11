// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  ClientSessionService, RefreshOutcomeClassifier, RefreshSchedule, SignOutService,
  type CloudAccountTransport, type PendingRevocationQueue, type RefreshLock, type SignOutResult, type TokenStore,
} from '@sulla/domain';
import { EventDispatcher, SystemClock, type Resolver } from '@sulla/foundation';

/** No listeners are registered in the vault, so the dispatcher never resolves anything. */
class NoListenerResolver implements Resolver {
  make<T>(): T { throw new Error('The vault session events have no listeners'); }
  has(): boolean { return false; }
}

/**
 * The vault's Sulla Cloud session custody: refresh (single-flight, stale result never wins) and sign-out
 * (revoke on the server with the token held here, then clear; a durable queue when offline). The token never leaves
 * the vault: callers get an access token for one request, or a yes/no.
 *
 * One instance per vault process: it holds the in-flight refresh and the sign-out gate.
 */
export class SullaCloudSessionManager {
  private readonly sessions: ClientSessionService;
  private readonly signOutService: SignOutService;

  constructor(store: TokenStore, transport: CloudAccountTransport, lock: RefreshLock, queue: PendingRevocationQueue) {
    const events = new EventDispatcher(new NoListenerResolver());
    const outcomes = new RefreshOutcomeClassifier();
    this.sessions = new ClientSessionService(store, transport, lock, new RefreshSchedule(new SystemClock()), outcomes, events);
    this.signOutService = new SignOutService(this.sessions, store, lock, transport, queue, [], events, outcomes);
  }

  /** A usable access token (refreshed ahead of expiry), or null when the session is gone, rejected or signed out. */
  accessToken(): Promise<string | null> {
    return this.sessions.accessToken();
  }

  /** Revokes with the vault-held refresh token, then clears it. Never sends a logout without a token. */
  signOut(): Promise<SignOutResult> {
    return this.signOutService.signOut();
  }

  /** Retries queued revokes (offline sign-outs). Call after unlock and after a new sign-in. */
  retryPendingRevocations(): Promise<void> {
    return this.signOutService.retryPendingRevocations();
  }

  /** A new session was adopted (sign-in): reopen the gate that sign-out closed. */
  sessionAdopted(): void {
    this.sessions.reopenGate();
  }
}
