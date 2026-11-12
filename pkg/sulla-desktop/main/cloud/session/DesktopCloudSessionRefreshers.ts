// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  ClientSessionService, IdentityError, RefreshOutcomeClassifier, RefreshSchedule, SignOutService,
  type PendingRevocationQueue, type RefreshLock, type SignOutResult,
} from '@sulla/domain';
import { EventDispatcher, SystemClock, type Clock } from '@sulla/foundation';

import { type CloudLogoutHttp, type CloudRefreshHttp, ElectronCloudRefreshTransport } from './ElectronCloudRefreshTransport';
import {
  DesktopRefreshLocks, LegacySignOutTokenStore, LegacyTokenStore, NoListenerResolver, PendingEntryTokenStore, UnavailableRevocationQueue,
  type CloudSessionStorage, type StoredCloudSession,
} from './DesktopTokenStores';

/** Reports refresh outcomes so the caller keeps its own log throttling. No tokens, ever. */
export interface RefreshReporter {
  failed(message: string): void;
  refreshed(): void;
}

/**
 * Desktop's legacy Sulla Cloud session refresh on the shared domain `ClientSessionService`: one network call for any
 * number of concurrent callers, the stored session re-read inside the lock, and a refresh that finishes after sign-out
 * discarded. A 5xx, 429, timeout or network failure keeps the tokens.
 */
export class LegacyCloudSessionRefresher<S extends StoredCloudSession> {
  private readonly store: LegacyTokenStore<S>;
  private readonly sessions: ClientSessionService;
  private readonly schedule: RefreshSchedule;
  private readonly signOutService: SignOutService;

  constructor(
    private readonly storage: CloudSessionStorage<S>,
    http: CloudRefreshHttp,
    private readonly reporter: RefreshReporter,
    lock: RefreshLock = DesktopRefreshLocks.shared,
    clock: Clock = new SystemClock(),
    logoutHttp: CloudLogoutHttp | null = null,
    revocations: PendingRevocationQueue = new UnavailableRevocationQueue(),
  ) {
    this.store = new LegacyTokenStore(storage);
    this.schedule = new RefreshSchedule(clock);
    const transport = new ElectronCloudRefreshTransport(http, logoutHttp);
    const events = new EventDispatcher(new NoListenerResolver());
    this.sessions = new ClientSessionService(this.store, transport, lock, this.schedule, new RefreshOutcomeClassifier(), events);
    this.signOutService = new SignOutService(
      this.sessions, new LegacySignOutTokenStore(this.store, storage), lock, transport, revocations, [], events,
    );
  }

  /**
   * Server-mode sign-out through the domain SignOutService: closes the refresh gate, waits for any in-flight refresh,
   * clears the stored session inside the refresh lock, and only then POSTs /auth/logout once with the newest refresh
   * token. Throws (gate reopened, nothing revoked) when the local clear fails. A blank refresh token is never sent.
   */
  signOut(): Promise<SignOutResult> {
    return this.signOutService.signOut();
  }

  /** A new session was signed in and stored: reopen the refresh gate that sign-out closed. */
  adopted(): void {
    this.sessions.reopenGate();
  }

  /** The stored access token, refreshed when within 60s of expiry. On any failure the stored token is returned, as before. */
  async currentAccessToken(): Promise<string> {
    const stored = await this.storage.load();
    const before = stored?.tokens.accessToken ?? '';
    if (!before) return '';
    if (!stored?.tokens.refreshToken) return before;
    const seen = await this.store.read();
    if (!seen) return before;
    if (!this.schedule.shouldRefresh(seen)) return seen.tokens.accessToken;
    try {
      const next = await this.sessions.refresh(seen);
      if (next && next.tokens.accessToken !== before) this.reporter.refreshed();
      if (next) return next.tokens.accessToken;
      return (await this.storage.load())?.tokens.accessToken ?? '';
    } catch (error) {
      this.reporter.failed(`Refresh failed: ${ error instanceof IdentityError ? error.message : error instanceof Error ? error.name : 'error' }`);
      return before;
    }
  }

  /** Call first when signing out: an in-flight refresh will not write tokens back afterwards. */
  invalidate(): void {
    this.store.invalidate();
  }
}

/** First-run: refreshes the pending Cloud session's tokens in memory when they are about to expire, before the vault adopts them. */
export class PendingCloudSessionRefresher {
  private readonly schedule: RefreshSchedule;

  constructor(
    private readonly http: CloudRefreshHttp,
    private readonly expired: () => Error,
    private readonly lock: RefreshLock = DesktopRefreshLocks.shared,
    clock: Clock = new SystemClock(),
    aheadMs = 120_000,
  ) {
    this.schedule = new RefreshSchedule(clock, aheadMs);
  }

  /** Rotates `entry.values` tokens in place when needed. Throws `expired()` when Cloud rejects the session; any other failure throws a retryable Error. */
  async refreshIfExpiring(entry: { values: Record<string, string> }): Promise<void> {
    const store = new PendingEntryTokenStore(entry);
    const sessions = new ClientSessionService(
      store, new ElectronCloudRefreshTransport(this.http), this.lock, this.schedule,
      new RefreshOutcomeClassifier(), new EventDispatcher(new NoListenerResolver()),
    );
    const seen = await store.read();
    if (!seen || !this.schedule.shouldRefresh(seen)) return;
    try {
      await sessions.refresh(seen);
    } catch (error) {
      const reason = error instanceof IdentityError ? error.message : error instanceof Error ? error.name : 'error';
      throw new Error(`Pending Cloud session needs refresh: ${ reason }`);
    }
    if (store.wasRejected()) throw this.expired();
  }
}
